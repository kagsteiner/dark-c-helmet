// The analysis grid (#/grid, reached from the Analysis screen with "Explore from here";
// desktop only). Small boards, one column per ply and one row per line. Click a board to
// open it large on the right. There the player plays moves (they become new
// boards), marks moves (!! … ??) and positions (++ … --), writes a comment, and marks a
// position as needing attention. The engine (the app's own, shared with the other screens)
// can be switched off for this screen; when it is on, it gives every board a quick look in
// the background, searches deeply the boards played by hand or marked for attention, shows
// the threat on the selected board and suggests moves on request.
import { placementFromFen } from "../chess/fen.ts";
import type { LegalMove, Rules } from "../chess/rules.ts";
import { san } from "../chess/san.ts";
import { Game } from "../chess/game.ts";
import { record, recordMoveLeadingHere } from "../book/book.ts";
import type { Engine, SearchInfo, SearchResult } from "../engine/engine.ts";
import type { PlayController } from "../play/controller.ts";
import { settings } from "../settings.ts";
import { load, save } from "../storage.ts";
import { icons } from "../ui/icons.ts";
import { Board } from "../ui/board.ts";
import { MoveInput } from "../ui/move-input.ts";
import { features } from "./features.ts";
import { GridView, materialView } from "./grid-view.ts";
import { currentAnalysis, deleteAnalysis, listAnalyses, newId, saveAnalysis, type Analysis, type SavedNode } from "./library.ts";
import { overMarks, underMarks } from "./marks.ts";
import { describeWin, forcingEnd, type LineMove } from "./threat-text.ts";
import { normalSan, parsePgn, writePgn, type Annotation, type PgnMove } from "./pgn.ts";
import {
  assess, MOVE_MARK_NAG, MOVE_MARK_TITLE, MOVE_MARKS, POS_MARK_NAG, POS_MARK_TITLE, POS_MARKS, scoreText, scoreValue, walk,
  whiteScore, type Ghost, type GNode, type MoveMark, type Origin, type PosMark, type Score,
} from "./tree.ts";
import "./grid.css";

/** Phones (narrow, or short in landscape): no grid, the panel alone. Same as in grid.css. */
const PHONE_QUERY = "(max-width: 700px), (max-height: 500px)";
const QUICK_MS = 250;
const DEEP_MS = 2000;
const SUGGEST_SCAN_MS = 80;
const SUGGEST_DEEP_MS = 700;
const SUGGEST_COUNT = 6;
/** Each "Think deeper" multiplies the time by this. The look at every move grows only with
 *  the square root: the extra time goes mostly to the best few. */
const DEEPER_STEP = 3;
const PV_PLIES = 6;
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// The sample: Italian Game after 4...Nf6, with a few lines.
const SAMPLE_FEN = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 3 5";
const SAMPLE_LINES = [
  "d2d4 e5d4 c3d4 c5b4 c1d2 b4d2 b1d2 d7d5 e4d5 f6d5",
  "d2d4 e5d4 c3d4 c5b4 b1c3 f6e4 e1g1 b4c3",
  "d2d4 e5d4 e4e5 d7d5 c4b5 f6e4",
  "d2d3 d7d6 e1g1 e8g8 f1e1 a7a6",
];

/** Builds the grid into `view`; resolves to the cleanup for leaving the screen. */
export async function mountGrid(
  view: HTMLElement,
  rules: Rules,
  controller: PlayController,
  engineStatus: () => string | null,
): Promise<() => void> {

  let nextId = 1;
  let chess960 = false;
  let root: GNode;
  let selected: GNode;
  let analysisId = newId();
  let analysisName = "";
  let flipped = false; // Black at the bottom
  // Both stored with each analysis. New analyses start with the engine off: switching it on
  // is always a deliberate click. Locked: the player's own analysis (e.g. a correspondence
  // game): no engine and nothing computed is shown, only the player's own marks and comments.
  let engineOn = false;
  let locked = false;
  /** The game this analysis belongs to (correspondence against the engine), if any. */
  let gameOf: string | null = null;
  /** The board of the game's current position (in an analysis of the running game). */
  let gameNode: GNode | null = null;
  /** After the next drawing, scroll the selected board into the middle of the grid: the
   *  screen or an analysis was opened (e.g. "Think in the grid" after a few more moves). */
  let revealOnDraw = true;

  // ---- Tree ----

  function makeRoot(fen: string): GNode | null {
    if (!rules.setFen(fen, chess960)) return null;
    return {
      id: nextId++, uci: null, san: "", moveNo: "", fen: rules.fen(), ply: 0, parent: null, children: [],
      state: rules.state(), lastMove: null, score: null, analysed: 0, depth: 0, origin: "seed", attention: false,
      comment: "", moveMark: null, posMark: null, expanded: true, ghost: null,
    };
  }

  function moveNumber(fen: string): string {
    const [, side, , , , full] = fen.split(" ");
    return side === "w" ? `${full}.` : `${full}…`;
  }

  /** The child reached by `uci`, created if it is new. Null if the move is not legal. */
  function child(parent: GNode, uci: string, origin: Origin): GNode | null {
    const existing = parent.children.find((c) => c.uci === uci);
    if (existing) return existing;
    rules.setFen(parent.fen, chess960);
    const legal = rules.moves();
    const m = legal.find((l) => l.uci === uci);
    if (!m || !rules.play(uci)) return null;
    const n: GNode = {
      id: nextId++, uci, san: san(m, legal), moveNo: moveNumber(parent.fen), fen: rules.fen(), ply: parent.ply + 1,
      parent, children: [], state: rules.state(), lastMove: [m.from, m.to], score: null, analysed: 0, depth: 0, origin,
      attention: false, comment: "", moveMark: null, posMark: null, expanded: true, ghost: null,
    };
    parent.children.push(n);
    return n;
  }

  function addLine(from: GNode, ucis: string[], origin: Origin): GNode {
    let n = from;
    for (const u of ucis) {
      const c = child(n, u, origin);
      if (!c) break;
      n = c;
    }
    return n;
  }

  /** A folded engine line after `n` (null if none of its moves is legal). */
  function makeGhost(n: GNode, ucis: string[], score: Score | null, depth: number): Ghost | null {
    rules.setFen(n.fen, chess960);
    const words: string[] = [];
    const played: string[] = [];
    let last: { san: string; moveNo: string; lastMove: [number, number] } | null = null;
    for (const u of ucis) {
      const fen = rules.fen();
      const legal = rules.moves();
      const m = legal.find((l) => l.uci === u);
      if (!m) break;
      const s = san(m, legal);
      const no = moveNumber(fen);
      words.push(fen.split(" ")[1] === "w" || !words.length ? `${no} ${s}` : s);
      rules.play(u);
      played.push(u);
      last = { san: s, moveNo: no, lastMove: [m.from, m.to] };
    }
    if (!last) return null;
    return { ucis: played, text: words.join(" "), fen: rules.fen(), state: rules.state(), score, depth: Math.max(0, depth), ...last };
  }

  /** A board on a search's main line takes the search's evaluation at `depth` (if that is at
   *  least as deep as what it has): it needs no quick look of its own. */
  function takeEval(n: GNode, score: Score | null, depth: number): boolean {
    if (!score || depth < 1 || depth < n.depth || n.state !== "ongoing") return false;
    n.score = score;
    n.depth = depth;
    n.analysed = 2;
    return true;
  }

  /** Turns a ghost into real boards: the whole line, or its next move (the ghost moves on).
   *  The next move becomes the selected board, so it is shown large in the panel. */
  function unfold(n: GNode, all: boolean): void {
    const g = n.ghost;
    if (!g) return;
    n.ghost = null;
    n.expanded = true;
    let next: GNode | null = null;
    // The new boards continue the search that found the line: its evaluation, one ply less
    // deep per move.
    if (all) {
      let m = n;
      for (const [k, u] of g.ucis.entries()) {
        const c = child(m, u, "engine");
        if (!c) break;
        takeEval(c, g.score, g.depth - k);
        m = c;
      }
    } else {
      next = child(n, g.ucis[0], "engine");
      if (next) takeEval(next, g.score, g.depth);
      if (next && g.ucis.length > 1 && !next.ghost && !next.children.length) next.ghost = makeGhost(next, g.ucis.slice(1), g.score, g.depth - 1);
    }
    persist();
    if (next) select(next);
    else draw();
    pump();
  }

  function serialize(n: GNode): SavedNode {
    return {
      uci: n.uci, score: n.score, analysed: n.analysed, depth: n.depth, origin: n.origin, attention: n.attention,
      comment: n.comment, moveMark: n.moveMark, posMark: n.posMark, expanded: n.expanded, children: n.children.map(serialize),
      ghost: n.ghost ? { ucis: n.ghost.ucis, score: n.ghost.score, depth: n.ghost.depth || undefined } : undefined,
      hidden: n.hidden || undefined,
      cut: n.cut || undefined,
    };
  }

  function applySaved(n: GNode, s: SavedNode): void {
    Object.assign(n, {
      score: s.score, analysed: s.analysed, depth: s.depth, expanded: s.expanded, attention: s.attention ?? s.toCheck ?? false,
      comment: s.comment ?? "", moveMark: s.moveMark ?? null, posMark: s.posMark ?? null, hidden: s.hidden ?? false,
      cut: s.cut ?? false,
    });
    if (s.ghost) n.ghost = makeGhost(n, s.ghost.ucis, s.ghost.score, s.ghost.depth ?? 0);
    for (const cs of s.children) {
      const c = child(n, cs.uci!, cs.origin);
      if (c) applySaved(c, cs);
    }
  }

  function open(a: Analysis): boolean {
    chess960 = a.chess960;
    const r = makeRoot(a.fen);
    if (!r) return false;
    root = r;
    applySaved(root, a.tree);
    selected = root;
    analysisId = a.id;
    analysisName = a.name;
    flipped = a.flipped ?? false;
    locked = a.locked ?? false;
    engineOn = !locked && (a.engineOn ?? false);
    gameOf = a.game ?? null;
    gameNode = null;
    syncGame();
    revealOnDraw = true;
    return true;
  }

  /** The analysis belongs to the game being played now, and it is not over: no engine, no
   *  computed hints, no unlocking. */
  function gameRunning(): boolean {
    return !!gameOf && controller.gameId === gameOf && !controller.result;
  }

  /** An analysis of the game being played: its moves become the main line (new ones are
   *  added), and the lock is on while the game goes on. */
  function syncGame(): void {
    if (!gameOf || controller.gameId !== gameOf) return;
    let n = root;
    const engineSide = controller.engineSide;
    for (const [ply, m] of controller.game.moves.entries()) {
      // An engine move the grid sees for the first time: did the player's analysis have it?
      // Their main line (first move) is a prediction, another of their lines a consideration;
      // lines after this position that miss it are a miss. Not analysed: not judged.
      if (n.fen.split(" ")[1] === engineSide && !controller.foresight[ply]) {
        const had = n.children.find((k) => k.uci === m.uci);
        const mine = n.children.filter((k) => k.origin !== "seed");
        if (had && had.origin !== "seed") controller.noteForesight(ply, mine[0] === had ? "predicted" : "considered");
        else if (!had && mine.length) controller.noteForesight(ply, "missed");
      }
      const c = child(n, m.uci, "seed");
      if (!c) break;
      n.children.splice(n.children.indexOf(c), 1);
      n.children.unshift(c);
      n.expanded = true;
      n = c;
    }
    gameNode = n;
    selected = n;
    for (let p: GNode | null = n; p; p = p.parent) p.hidden = false;
    if (gameRunning()) {
      locked = true;
      engineOn = false;
    }
  }

  /** The analysis of the game being played (made when first needed). */
  function openGame(id: string, existing: Analysis | null): boolean {
    if (controller.gameId !== id) return false;
    if (existing) return open(existing);
    const s = controller.setup;
    const date = new Date(controller.startedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    if (!startNew(s.startFen, s.chess960, `Game vs Dark C. Helmet, ${date}`, s.human === "b")) return false;
    analysisId = "game-" + id;
    gameOf = id;
    syncGame();
    return true;
  }

  function startNew(fen: string, is960: boolean, name: string, blackBelow = false): boolean {
    const was = chess960;
    chess960 = is960;
    const r = makeRoot(fen);
    if (!r) {
      chess960 = was;
      return false;
    }
    root = r;
    selected = root;
    analysisId = newId();
    analysisName = name;
    flipped = blackBelow;
    engineOn = false;
    locked = false;
    gameOf = null;
    gameNode = null;
    return true;
  }

  function sample(): void {
    startNew(SAMPLE_FEN, false, "Italian Game (sample)");
    for (const line of SAMPLE_LINES) addLine(root, line.split(" "), "seed");
  }

  function today(): string {
    return new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  /** The analysis as it is saved. */
  function snapshot(): Analysis {
    let boards = 0;
    walk(root, () => boards++);
    return {
      id: analysisId, name: analysisName, updated: Date.now(), fen: root.fen, chess960, tree: serialize(root), boards, flipped,
      engineOn, locked, ...(gameOf ? { game: gameOf } : {}),
    };
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function persist(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveAnalysis(snapshot()), 400);
  }

  const last = await currentAnalysis();
  if (!last || !open(last)) sample();
  // "Explore from here" on the Analysis screen: a new analysis from that position.
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const fromFen = params.get("fen");
  const forGame = params.get("game");
  if (forGame) {
    // "Think in the grid" on the game screen: the analysis of that game.
    history.replaceState(null, "", "#/grid");
    const mine = (await listAnalyses()).find((a) => a.game === forGame) ?? null;
    if (!openGame(forGame, mine) && (!last || !open(last))) sample();
  } else if (fromFen) {
    history.replaceState(null, "", "#/grid"); // a later visit opens the analysis again, not a new one
    const full = fromFen.split(" ")[5] ?? "1";
    const blackBelow = params.get("black") === "1"; // as the Analysis screen showed it
    if (!startNew(fromFen, params.get("chess960") === "1", `${today()}, move ${full}`, blackBelow) && (!last || !open(last))) sample();
  }

  // ---- Page ----

  const app = view;
  const originalTitle = document.title; // restored when leaving the screen
  app.innerHTML = `
    <header class="ag-bar">
      <strong class="ag-title">Analysis grid</strong>
      <input class="ag-name" type="text" spellcheck="false" title="Name of this analysis" />
      <button class="ag-library btn-secondary">Analyses…</button>
      <button class="ag-new btn-secondary">New…</button>
      <button class="ag-import btn-secondary">Import PGN</button>
      <button class="ag-export btn-secondary">Export PGN</button>
      <input class="ag-file" type="file" accept=".pgn,text/plain" hidden />
      <span class="ag-sep"></span>
      <label class="ag-size">Size <input type="range" min="56" max="200" step="4" value="96" /></label>
      <button class="ag-expand btn-secondary">Expand all</button>
      <button class="ag-collapse btn-secondary">Collapse all</button>
      <button class="ag-flip btn-icon" aria-label="Swap sides" title="Swap sides: Black or White at the bottom">${icons.flip}</button>
      <span class="ag-spacer"></span>
      <span class="ag-engine muted"></span>
      <button class="ag-engine-toggle" role="switch"></button>
      <button class="ag-lock"></button>
    </header>
    <main class="ag-main">
      <section class="ag-grid"></section>
      <div class="ag-split" role="separator" aria-orientation="vertical" tabindex="0"
        aria-label="Width of the panel" title="Drag to give the grid or the panel more room (double-click: back to normal)"></div>
      <aside class="ag-panel">
        <div class="ag-game" hidden>
          <p class="ag-game-text"></p>
          <div class="ag-nav">
            <button class="ag-game-play btn-primary"></button>
            <a class="ag-game-back btn-secondary" href="#/play">Back to the game</a>
          </div>
        </div>
        <div class="ag-board"></div>
        <div class="ag-info">
          <div class="ag-line"><span class="ag-move"></span><span class="ag-score numeric"></span></div>
          <div class="ag-status muted"></div>
          <div class="ag-assess"></div>
          <div class="ag-threat"></div>
        </div>
        <div class="ag-vars">
          <p class="ag-phone-note small muted">On a phone the grid is left out: the board, and your lines
            as moves. Play moves on the board, ◀ takes you back. A larger screen shows the whole grid.</p>
          <div class="ag-var-line"></div>
          <div class="ag-var-alt"></div>
          <div class="ag-var-next"></div>
        </div>
        <div class="ag-nav">
          <button class="ag-back btn-secondary" title="Previous move (←)">◀</button>
          <button class="ag-fwd btn-secondary" title="Next move (→)">▶</button>
          <button class="ag-suggest btn-secondary">Suggest moves</button>
          <button class="ag-deep btn-secondary" title="One search of the position, as deep as you let it run: what the engine itself would play">Deep search</button>
          <button class="ag-attention" aria-pressed="false">Needs attention</button>
          <button class="ag-cut btn-secondary" aria-pressed="false">Not needed</button>
        </div>
        <div class="ag-marks">
          <span class="ag-marks-label muted">Move</span>
          <div class="ag-seg ag-move-marks"></div>
          <span class="ag-marks-label muted">Position</span>
          <div class="ag-seg ag-pos-marks"></div>
        </div>
        <textarea class="ag-comment" rows="2" placeholder="Comment, e.g. leads to complications, but I like it"></textarea>
        <div class="ag-nav">
          <button class="ag-main-line btn-secondary">Make main line</button>
          <button class="ag-delete btn-secondary danger">Delete from here</button>
        </div>
        <div class="ag-ghost">
          <p class="ag-ghost-text"></p>
          <div class="ag-nav">
            <button class="ag-unfold-one btn-secondary">Unfold next move</button>
            <button class="ag-unfold-all btn-secondary">Unfold whole line</button>
            <button class="ag-discard btn-secondary danger">Discard</button>
          </div>
        </div>
        <div class="ag-suggestions"></div>
        <div class="ag-material"></div>
        <ul class="ag-notes"></ul>
        <details class="ag-help muted">
          <summary>What the grid shows</summary>
          <p>The bar left of each board: black on top, white from the bottom. Half and half is
            0.0; the white part grows with White's advantage (all white at +8 or a mate for White,
            all black at −8). It shows the engine's evaluation, or your own position mark (hatched)
            when the engine is off.</p>
          <p>On the boards: a red glow around a king in danger, a red dot on weak pawns (isolated or
            doubled), a green arrow on passed pawns. Below: the extra material, and a speech bubble
            when there is a comment (hover it to read).</p>
          <p>A faded, dashed board is an engine line you added from the suggestions, still folded:
            its final position. Click it to unfold the whole line; click the "moves" sign on the
            connector to unfold one move at a time.</p>
          <p>The engine setting is kept with each analysis; a new analysis starts with the engine
          off. "Lock" makes an analysis your own (e.g. for a correspondence game): no engine, and
          nothing computed is shown, no marks on the boards, no material, no notes, no engine
          lines; only your own marks and comments. Unlocking asks first.</p>
        <p>An orange frame marks a position that needs attention; with the engine on it also gets a
            deep search, as do moves you play yourself (✓ when done).</p>
          <p>Your position marks work backwards: a position whose lines after it all carry a mark
            gets the best of them for the side to move (an outlined mark), and a thick line follows
            the moves your marks choose. A mark you set yourself (solid) always wins. A position
            that needs attention, or is marked unclear (∞), leaves everything before it open.
            "Not needed" (✂, faded) is a cutoff by hand: another move already settles the
            position before it, so the marks leave this move out, and the engine skips it.</p>
          <p>Right-click a board for more: needs attention, make main line, hide the line from
            there on, delete. A hidden line shows as one small board, the end of the line, with the
            lines branching off it added up (+N); click it to show the line again.</p>
        </details>
      </aside>
    </main>
    <dialog class="ag-dialog ag-new-dialog">
      <form method="dialog">
        <p><strong>New analysis</strong></p>
        <p><input class="ag-new-name" type="text" placeholder="Name" /></p>
        <p><input class="ag-fen" type="text" spellcheck="false" placeholder="FEN (empty: the normal start position)" /></p>
        <p><label><input class="ag-960" type="checkbox" /> Chess960</label></p>
        <p class="ag-fen-error error"></p>
        <p class="ag-dialog-buttons">
          <button value="ok" type="submit" class="btn-primary">Start</button>
          <button value="cancel" type="submit" class="btn-secondary">Cancel</button>
          <button value="sample" type="submit" class="btn-secondary">Load the sample</button>
        </p>
        <p class="muted">The current analysis stays in the list (Analyses…).</p>
      </form>
    </dialog>
    <dialog class="ag-dialog ag-library-dialog">
      <form method="dialog">
        <p><strong>Analyses on this device</strong></p>
        <ul class="ag-library-list"></ul>
        <p class="ag-dialog-buttons"><button value="close" type="submit" class="btn-secondary">Close</button></p>
      </form>
    </dialog>`;
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => app.querySelector<T>(s)!;

  // ---- The divider between grid and panel: drag it to give either more room; the panel's
  // board grows with the panel. Kept on this device. ----

  const PANEL_WIDTH_KEY = "grid-panel-width";
  const PANEL_DEFAULT = 380;
  const PANEL_MIN = 300;
  const GRID_MIN = 240;
  const panelEl = $(".ag-panel");
  const split = $(".ag-split");
  function setPanelWidth(w: number, keep = false): void {
    const total = $(".ag-main").getBoundingClientRect().width;
    const max = Math.max(PANEL_MIN, total - GRID_MIN - split.offsetWidth);
    const width = Math.round(Math.min(max, Math.max(PANEL_MIN, w)));
    panelEl.style.width = width + "px";
    split.setAttribute("aria-valuenow", String(width));
    split.setAttribute("aria-valuemin", String(PANEL_MIN));
    split.setAttribute("aria-valuemax", String(Math.round(max)));
    if (keep) void save(PANEL_WIDTH_KEY, width);
    // The board grows with the panel, up to the panel's visible height (less its padding).
    const pad = parseFloat(getComputedStyle(panelEl).paddingTop) + parseFloat(getComputedStyle(panelEl).paddingBottom);
    panelEl.style.setProperty("--ag-board-max", Math.max(200, panelEl.clientHeight - pad) + "px");
  }
  // Measured once the screen is on the page; then the width kept from last time.
  requestAnimationFrame(() => {
    if (panelEl.isConnected) setPanelWidth(panelEl.getBoundingClientRect().width || PANEL_DEFAULT);
    void load<number>(PANEL_WIDTH_KEY).then((w) => {
      if (typeof w !== "number" || !panelEl.isConnected) return;
      setPanelWidth(w);
      // The grid got narrower or wider: the selected board in its middle again.
      requestAnimationFrame(() => grid.reveal(selected, true));
    });
  });
  split.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    split.classList.add("dragging");
    const right = $(".ag-main").getBoundingClientRect().right;
    const move = (ev: PointerEvent) => setPanelWidth(right - ev.clientX - split.offsetWidth / 2);
    const up = () => {
      split.removeEventListener("pointermove", move);
      split.removeEventListener("pointerup", up);
      split.removeEventListener("pointercancel", up);
      split.classList.remove("dragging");
      setPanelWidth(panelEl.getBoundingClientRect().width, true);
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", up);
    split.addEventListener("pointercancel", up);
  });
  split.addEventListener("dblclick", () => setPanelWidth(PANEL_DEFAULT, true));
  split.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 80 : 20;
    const w = panelEl.getBoundingClientRect().width;
    if (e.key === "ArrowLeft") setPanelWidth(w + step, true);
    else if (e.key === "ArrowRight") setPanelWidth(w - step, true);
    else return;
    e.preventDefault();
    e.stopPropagation(); // not the grid's move keys
  });
  const onResize = () => setPanelWidth(panelEl.getBoundingClientRect().width);
  window.addEventListener("resize", onResize);

  // A board clicked in the grid: the panel scrolls back up, so its board shows in full.
  const panelTop = () => $(".ag-panel").scrollTo({ top: 0 });
  const grid = new GridView({
    select: (n) => {
      select(n);
      panelTop();
    },
    toggle: (n) => {
      n.expanded = !n.expanded;
      persist();
      draw();
    },
    unfold: (n, all) => {
      unfold(n, all);
      panelTop();
    },
    show: (n) => {
      showLine(n);
      panelTop();
    },
    menu: (n, kind, x, y) => openMenu(n, kind, x, y),
    hanging: (fen) => {
      if (locked) return [];
      rules.setFen(fen, chess960);
      return rules.hanging();
    },
  });
  $(".ag-grid").append(grid.el);

  const board = new Board();
  $(".ag-board").append(board.el);
  // Analysis marks on the large board: the glow under the pieces, dots and arrows above.
  const marksUnder = document.createElement("div");
  marksUnder.className = "fm-layer";
  const marksOver = document.createElement("div");
  marksOver.className = "fm-layer";
  board.el.insertBefore(marksUnder, board.el.querySelector(".board-pieces"));
  board.el.append(marksOver);

  const input = new MoveInput(board, {
    onMove: (uci) => {
      // The next move of a folded engine line: unfold it (the ghost moves on).
      if (!locked && selected.ghost?.ucis[0] === uci) {
        const from = selected;
        unfold(from, false);
        const c = from.children.find((k) => k.uci === uci);
        if (c) select(c);
        return;
      }
      const c = child(selected, uci, "user");
      if (!c) return;
      persist();
      select(c);
      pump();
    },
    targetOnly: () => settings().targetOnly,
  });
  input.setMode("move");

  function select(n: GNode): void {
    // A board inside a hidden line (reached with the arrow keys): the line shows again.
    let shown = false;
    for (let p: GNode | null = n; p; p = p.parent) {
      if (p.hidden) {
        p.hidden = false;
        shown = true;
      }
    }
    if (shown) persist();
    if (n !== selected) {
      suggestions = null;
      // Suggestions belong to their board: leaving it drops a search still running.
      if (suggesting) {
        suggestRun++;
        engine?.stop();
      }
    }
    selected = n;
    draw();
    grid.reveal(n);
    pump(); // its threat, if not known yet
  }

  let drawPending = false;
  function draw(): void {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => {
      drawPending = false;
      grid.engineOn = engineOn;
      grid.hints = !locked;
      grid.flipped = flipped;
      grid.render(root, selected);
      if (revealOnDraw) {
        revealOnDraw = false;
        grid.reveal(selected, true);
      }
      drawPanel();
      drawGame();
    });
  }

  /** The strip for the game this analysis belongs to: whose move it is, the move to play
   *  (the first move of the selected line after the game's position), back to the game. */
  function drawGame(): void {
    const box = $(".ag-game");
    const ours = !!gameOf && controller.gameId === gameOf;
    box.hidden = !ours;
    if (!ours) return;
    const text = $(".ag-game-text");
    const play = $<HTMLButtonElement>(".ag-game-play");
    const move = gameMove();
    if (controller.result) text.textContent = `This game is over: ${controller.result}`;
    else if (!controller.humanToMove) text.textContent = "Your game: the engine is to move. Go back to the game to let it play.";
    else text.textContent = move
      ? "Your game: your move. When you have decided, play it from here."
      : phone.matches
        ? "Your game: your move. Go to a move after the game's position (the end of the main line) to play it."
        : "Your game: your move. Select a board after the game's position (the last board of the main line) to play its move.";
    play.hidden = !!controller.result || !controller.humanToMove;
    play.disabled = !move;
    play.textContent = move ? `Play ${move.moveNo} ${move.san} in the game` : "Play in the game";
  }

  /** The move the player would play in the game: the first move of the line to the selected
   *  board after the game's position, if the selection is on such a line. */
  function gameMove(): GNode | null {
    if (!gameNode || !gameRunning() || !controller.humanToMove) return null;
    for (let n: GNode | null = selected; n?.parent; n = n.parent) if (n.parent === gameNode) return n;
    return null;
  }

  // Mark buttons: built once.
  function segment(box: HTMLElement, marks: readonly string[], titles: Record<string, string>, onPick: (m: string) => void): void {
    for (const m of marks) {
      const b = document.createElement("button");
      b.textContent = m;
      b.title = titles[m];
      b.dataset.mark = m;
      b.addEventListener("click", () => onPick(m));
      box.append(b);
    }
  }
  segment($(".ag-move-marks"), MOVE_MARKS, MOVE_MARK_TITLE, (m) => {
    if (!selected.parent) return;
    selected.moveMark = selected.moveMark === m ? null : (m as MoveMark);
    persist();
    draw();
  });
  segment($(".ag-pos-marks"), POS_MARKS, POS_MARK_TITLE, (m) => {
    selected.posMark = selected.posMark === m ? null : (m as PosMark);
    persist();
    draw();
  });

  function drawPanel(): void {
    const n = selected;
    rules.setFen(n.fen, chess960);
    const legal = rules.moves();
    const placement = placementFromFen(n.fen);
    const whiteToMove = n.fen.split(" ")[1] === "w";
    let check: number | undefined;
    if (rules.inCheck()) check = placement.indexOf(whiteToMove ? "K" : "k");
    input.setPosition(placement, legal, whiteToMove, { lastMove: n.lastMove ?? undefined, check });
    board.setOrientation(flipped ? "black" : "white");
    board.setPlacement(placement, false);
    const fx = features(placement);
    // Locked: nothing computed (no marks, no exchange check, no notes).
    const hanging = locked ? [] : rules.hanging();
    marksUnder.replaceChildren(...(locked ? [] : underMarks(fx, flipped)));
    marksOver.replaceChildren(...(locked ? [] : overMarks(fx, hanging, flipped)));
    drawThreat(n, rules.inCheck());

    $(".ag-move").textContent = (n.uci ? `${n.moveNo} ${n.san}` : "Start position") + (n.moveMark ?? "");
    const a = assess(root).get(n)!;
    $(".ag-score").textContent = [a.mark ?? "", engineOn ? scoreText(n.score, n.state) : ""].filter(Boolean).join("  ");
    let note = "";
    if (a.own && a.derived && a.derived !== a.mark) note = `Your lines after it say ${a.derived}.`;
    else if (!a.own && a.mark && n.state === "ongoing") note = `${a.mark} follows from your marks on the lines after it.`;
    if (n.attention && a.mark) note = (note ? note + " " : "") + "Needs attention: counts for nothing before it until you remove the mark.";
    if (n.cut) note = "Not needed: the marks before it leave this move out.";
    $(".ag-assess").textContent = note;
    let status = "";
    if (n.state !== "ongoing") status = n.state;
    else if (engineOn) {
      status = n.analysed === 0 ? "not analysed yet" : `depth ${n.depth}${n.analysed === 2 ? ", deep search" : ", quick look"}`;
      if (wantsDeep(n) && n.analysed < 2) status += " · deep search to come";
    }
    $(".ag-status").textContent = status;

    const att = $(".ag-attention");
    att.setAttribute("aria-pressed", String(n.attention));
    att.title = n.attention ? "Remove the mark" : "Mark this position: it needs attention";
    const cutBtn = $<HTMLButtonElement>(".ag-cut");
    cutBtn.setAttribute("aria-pressed", String(!!n.cut));
    cutBtn.disabled = !n.parent;
    cutBtn.title = n.cut
      ? "Count this move again"
      : "This move need not be analysed: another move already settles the position before it (a cutoff by hand). The marks before it leave it out.";
    for (const b of $(".ag-move-marks").children as HTMLCollectionOf<HTMLButtonElement>) {
      b.classList.toggle("on", b.dataset.mark === n.moveMark);
      b.disabled = !n.parent;
    }
    for (const b of $(".ag-pos-marks").children as HTMLCollectionOf<HTMLButtonElement>) b.classList.toggle("on", b.dataset.mark === n.posMark);
    const comment = $<HTMLTextAreaElement>(".ag-comment");
    if (comment.dataset.node !== String(n.id)) {
      comment.value = n.comment;
      comment.dataset.node = String(n.id);
    }

    $<HTMLButtonElement>(".ag-back").disabled = !n.parent;
    $<HTMLButtonElement>(".ag-fwd").disabled = !n.children.length;
    $<HTMLButtonElement>(".ag-delete").disabled = !n.parent;
    $<HTMLButtonElement>(".ag-main-line").disabled = !n.parent || n.parent.children[0] === n;
    const sug = $<HTMLButtonElement>(".ag-suggest");
    sug.hidden = !engineOn;
    sug.disabled = !engine || n.state !== "ongoing" || suggesting;
    const deepBtn = $<HTMLButtonElement>(".ag-deep");
    deepBtn.hidden = !engineOn;
    deepBtn.disabled = sug.disabled;

    const ghost = $(".ag-ghost");
    ghost.hidden = !n.ghost || locked;
    if (n.ghost) $(".ag-ghost-text").textContent = `Engine line (folded, ${n.ghost.ucis.length} moves): ${n.ghost.text}`;

    const mat = locked ? null : materialView(fx);
    $(".ag-material").replaceChildren(...(mat ? [mat] : []));
    const PIECE_NAME: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" };
    const lost = hanging.map((sq) => {
      const p = placement[sq]!;
      const white = p === p.toUpperCase();
      return `${white ? "White" : "Black"} ${PIECE_NAME[p.toLowerCase()]} on ${"abcdefgh"[sq & 7]}${(sq >> 3) + 1} is lost in the exchange`;
    });
    $(".ag-notes").innerHTML = locked ? "" : [...lost, ...fx.notes].map((t) => `<li>${t}</li>`).join("");
    drawVars(n);
    drawSuggestions();
  }

  // ---- The lines as moves: on a phone, in place of the grid (CSS shows them there only) ----

  /** Phones (narrow, or short in landscape): the panel alone, no grid. Same query as the CSS. */
  const phone = matchMedia(PHONE_QUERY);
  /** The boards behind the move buttons of the lines, by id. */
  let varNodes = new Map<number, GNode>();

  function moveButton(m: GNode, withNo: boolean, cls = ""): string {
    varNodes.set(m.id, m);
    const no = withNo || m.moveNo.endsWith(".") ? `<span class="muted">${m.moveNo}</span>` : "";
    return `<button class="ag-var ${cls}" data-id="${m.id}">${no}${m.san}${m.moveMark ?? ""}</button>`;
  }

  function drawVars(n: GNode): void {
    varNodes = new Map();
    // The line to this board, and on from it along the main line (faded).
    const path: GNode[] = [];
    for (let p: GNode | null = n; p?.parent; p = p.parent) path.unshift(p);
    const ahead: GNode[] = [];
    for (let c = n.children[0]; c && ahead.length < 12; c = c.children[0]) ahead.push(c);
    const start = `<button class="ag-var${n.parent ? "" : " on"}" data-id="${root.id}">Start</button>`;
    varNodes.set(root.id, root);
    $(".ag-var-line").innerHTML =
      start +
      path.map((m, i) => moveButton(m, i === 0, m === n ? "on" : "")).join("") +
      ahead.map((m, i) => moveButton(m, i === 0 && (!n.parent || n.moveNo.endsWith(".")), "ahead")).join("");
    // Other moves instead of this one, and the moves after it.
    const others = n.parent ? n.parent.children.filter((c) => c !== n) : [];
    $(".ag-var-alt").innerHTML = others.length
      ? `<span class="ag-var-label muted">Instead of ${n.san}:</span>` + others.map((m) => moveButton(m, true)).join("")
      : "";
    $(".ag-var-next").innerHTML = n.children.length > 1
      ? `<span class="ag-var-label muted">Lines from here:</span>` + n.children.map((m, i) => moveButton(m, true, i === 0 ? "main" : "")).join("")
      : "";
    $(".ag-var-line .on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  $(".ag-vars").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".ag-var");
    const m = b && varNodes.get(Number(b.dataset.id));
    if (m) select(m);
  });

  // ---- Panel actions ----

  $(".ag-back").addEventListener("click", () => selected.parent && select(selected.parent));
  $(".ag-fwd").addEventListener("click", () => selected.children[0] && select(selected.children[0]));
  // ---- Actions on a board (panel buttons and the context menu) ----

  function toggleAttention(n: GNode): void {
    n.attention = !n.attention;
    persist();
    draw();
    pump();
  }

  function toggleCut(n: GNode): void {
    if (!n.parent) return;
    n.cut = !n.cut;
    persist();
    draw();
  }

  function makeMainLine(n: GNode): void {
    const p = n.parent;
    if (!p) return;
    p.children.splice(p.children.indexOf(n), 1);
    p.children.unshift(n);
    persist();
    draw();
  }

  function deleteFrom(n: GNode): void {
    const p = n.parent;
    if (!p) return;
    let count = 0;
    walk(n, () => count++);
    if (!confirm(`Delete ${n.moveNo} ${n.san} and ${count - 1} board${count === 2 ? "" : "s"} after it?`)) return;
    p.children.splice(p.children.indexOf(n), 1);
    persist();
    if (isIn(selected, n)) select(p);
    else draw();
  }

  /** Hides `n` and everything after it: drawn as one small board, the end of its line. */
  function hideLine(n: GNode): void {
    if (!n.parent) return;
    n.hidden = true;
    persist();
    if (isIn(selected, n)) select(n.parent);
    else draw();
  }

  function showLine(n: GNode): void {
    n.hidden = false;
    persist();
    select(n);
  }

  /** `n` is `top` or comes after it. */
  function isIn(n: GNode, top: GNode): boolean {
    for (let p: GNode | null = n; p; p = p.parent) if (p === top) return true;
    return false;
  }

  /** More than one line from `n` on (something branches off). */
  function branches(n: GNode): boolean {
    let more = false;
    walk(n, (k) => {
      if (k.children.length > 1) more = true;
    });
    return more;
  }

  // ---- Context menu (right click on a board in the grid) ----

  const menu = document.createElement("div");
  menu.className = "ag-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  app.append(menu);

  function closeMenu(): void {
    menu.hidden = true;
    menu.replaceChildren();
  }

  function openMenu(n: GNode, kind: "board" | "hidden" | "ghost", x: number, y: number): void {
    closeMenu();
    const item = (text: string, run: () => void, opts: { disabled?: boolean; danger?: boolean; check?: boolean } = {}) => {
      const b = document.createElement("button");
      b.setAttribute("role", "menuitem");
      b.textContent = text;
      if (opts.check !== undefined) {
        const c = document.createElement("span");
        c.className = "check";
        c.textContent = opts.check ? "✓" : "";
        b.append(c);
      }
      if (opts.danger) b.classList.add("danger");
      b.disabled = !!opts.disabled;
      b.addEventListener("click", () => {
        closeMenu();
        run();
      });
      menu.append(b);
    };
    const line = () => menu.append(document.createElement("hr"));
    if (kind === "board") {
      select(n);
      panelTop();
      item("Needs attention", () => toggleAttention(n), { check: n.attention });
      item("Not needed", () => toggleCut(n), { check: !!n.cut, disabled: !n.parent });
      item("Make main line", () => makeMainLine(n), { disabled: !n.parent || n.parent.children[0] === n });
      item(branches(n) ? "Hide lines" : "Hide line", () => hideLine(n), { disabled: !n.parent });
      line();
      item("Delete from here…", () => deleteFrom(n), { disabled: !n.parent, danger: true });
    } else if (kind === "hidden") {
      item(branches(n) ? "Show lines" : "Show line", () => {
        showLine(n);
        panelTop();
      });
      item("Make main line", () => makeMainLine(n), { disabled: !n.parent || n.parent.children[0] === n });
      line();
      item("Delete from here…", () => deleteFrom(n), { disabled: !n.parent, danger: true });
    } else {
      item("Unfold next move", () => {
        unfold(n, false);
        panelTop();
      });
      item("Unfold whole line", () => unfold(n, true));
      line();
      item("Discard", () => {
        n.ghost = null;
        persist();
        draw();
      }, { danger: true });
    }
    menu.hidden = false;
    // Inside the window, also near its right and bottom edges.
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + "px";
    menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + "px";
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }

  const onMenuAway = (e: Event) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) closeMenu();
  };
  document.addEventListener("pointerdown", onMenuAway, true);
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", closeMenu);
  grid.el.addEventListener("scroll", closeMenu);

  $(".ag-attention").addEventListener("click", () => toggleAttention(selected));
  // The move is played in the game, then back to the game screen, where the engine replies.
  $(".ag-game-play").addEventListener("click", () => {
    const m = gameMove();
    if (!m?.uci || !controller.humanMove(m.uci)) return;
    gameNode = m;
    persistNow();
    location.hash = "#/play";
  });
  $(".ag-cut").addEventListener("click", () => toggleCut(selected));
  $<HTMLTextAreaElement>(".ag-comment").addEventListener("input", (e) => {
    selected.comment = (e.target as HTMLTextAreaElement).value;
    persist();
    draw();
  });
  $(".ag-unfold-one").addEventListener("click", () => unfold(selected, false));
  $(".ag-unfold-all").addEventListener("click", () => unfold(selected, true));
  $(".ag-discard").addEventListener("click", () => {
    selected.ghost = null;
    persist();
    draw();
  });
  $(".ag-main-line").addEventListener("click", () => makeMainLine(selected));
  $(".ag-delete").addEventListener("click", () => deleteFrom(selected));
  const onKey = (e: KeyboardEvent) => {
    if (!menu.hidden) {
      if (e.key === "Escape") closeMenu();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      } else return;
      e.preventDefault();
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (document.querySelector("dialog[open]")) return;
    if (e.key === "ArrowLeft" && selected.parent) select(selected.parent);
    else if (e.key === "ArrowRight" && selected.children[0]) select(selected.children[0]);
    // At the end of the line, a folded engine line unfolds one move (as "Unfold next move").
    else if (e.key === "ArrowRight" && selected.ghost && !locked) unfold(selected, false);
    else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && selected.parent) {
      const sib = selected.parent.children;
      const i = sib.indexOf(selected) + (e.key === "ArrowDown" ? 1 : -1);
      if (sib[i]) {
        selected.parent.expanded = true;
        select(sib[i]);
      }
    } else return;
    e.preventDefault();
  };
  document.addEventListener("keydown", onKey);

  // ---- Toolbar ----

  const nameInput = $<HTMLInputElement>(".ag-name");
  function showName(): void {
    nameInput.value = analysisName;
    document.title = `${analysisName} · Analysis grid`;
  }
  nameInput.addEventListener("change", () => {
    analysisName = nameInput.value.trim() || "Analysis";
    showName();
    persist();
  });

  $<HTMLInputElement>(".ag-size input").addEventListener("input", (e) => {
    grid.size = Number((e.target as HTMLInputElement).value);
    draw();
  });
  $(".ag-flip").addEventListener("click", () => {
    flipped = !flipped;
    persist();
    draw();
  });
  $(".ag-expand").addEventListener("click", () => {
    walk(root, (n) => (n.expanded = true));
    persist();
    draw();
  });
  $(".ag-collapse").addEventListener("click", () => {
    walk(root, (n) => (n.expanded = false));
    // Keep the selected board visible.
    for (let n: GNode | null = selected; n?.parent; n = n.parent) if (n.parent.children[0] !== n) n.parent.expanded = true;
    persist();
    draw();
  });

  /** Switches to another tree: drops the engine's work on the old one. */
  async function switched(): Promise<void> {
    clearTimeout(saveTimer);
    await stopAnalysis();
    suggestions = null;
    showName();
    syncEngine(); // the engine setting comes with the analysis
    drawEngineToggle();
    persist();
    draw();
    pump();
  }

  const newDialog = $<HTMLDialogElement>(".ag-new-dialog");
  $(".ag-new").addEventListener("click", () => {
    $<HTMLInputElement>(".ag-new-name").value = `Analysis ${today()}`;
    $<HTMLInputElement>(".ag-fen").value = "";
    $<HTMLInputElement>(".ag-960").checked = false;
    $(".ag-fen-error").textContent = "";
    newDialog.returnValue = "";
    newDialog.showModal();
  });
  newDialog.addEventListener("close", async () => {
    if (newDialog.returnValue !== "ok" && newDialog.returnValue !== "sample") return;
    persistNow();
    if (newDialog.returnValue === "sample") sample();
    else {
      const fen = $<HTMLInputElement>(".ag-fen").value.trim() || START_FEN;
      const name = $<HTMLInputElement>(".ag-new-name").value.trim() || `Analysis ${today()}`;
      if (!startNew(fen, $<HTMLInputElement>(".ag-960").checked, name)) {
        $(".ag-fen-error").textContent = "That FEN is not a legal position.";
        newDialog.returnValue = "";
        newDialog.showModal();
        return;
      }
    }
    await switched();
  });

  /** Saves the current tree at once (before switching to another one). */
  function persistNow(): void {
    clearTimeout(saveTimer);
    saveAnalysis(snapshot());
  }

  const libDialog = $<HTMLDialogElement>(".ag-library-dialog");
  $(".ag-library").addEventListener("click", async () => {
    persistNow();
    await drawLibrary();
    libDialog.showModal();
  });

  async function drawLibrary(): Promise<void> {
    const list = $(".ag-library-list");
    const all = await listAnalyses();
    list.replaceChildren();
    for (const a of all) {
      const li = document.createElement("li");
      const info = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = a.name + (a.id === analysisId ? " (open)" : "");
      const meta = document.createElement("div");
      meta.className = "muted";
      const engineNote = a.locked ? " · locked: own analysis, no engine" : a.engineOn ? " · engine on" : "";
      meta.textContent = `${a.boards} boards${a.chess960 ? ", Chess960" : ""}${engineNote} · ${new Date(a.updated).toLocaleString()}`;
      info.append(name, meta);
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "btn-secondary";
      openBtn.textContent = "Open";
      openBtn.disabled = a.id === analysisId;
      openBtn.addEventListener("click", async () => {
        libDialog.close();
        if (open(a)) await switched();
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn-secondary danger";
      del.textContent = "Delete";
      del.disabled = a.id === analysisId;
      del.addEventListener("click", async () => {
        if (!confirm(`Delete "${a.name}" from this device? This cannot be undone.`)) return;
        await deleteAnalysis(a.id);
        await drawLibrary();
      });
      li.append(info, openBtn, del);
      list.append(li);
    }
  }

  // ---- PGN ----

  const NAG_MOVE = new Map(Object.entries(MOVE_MARK_NAG).map(([m, n]) => [n, m as MoveMark]));
  const NAG_POS = new Map(Object.entries(POS_MARK_NAG).map(([m, n]) => [n, m as PosMark]));

  function annotate(n: GNode): Annotation {
    const nags: number[] = [];
    const cmds: string[] = [];
    if (n.parent) {
      if (n.moveMark) nags.push(MOVE_MARK_NAG[n.moveMark]);
      if (n.posMark) nags.push(POS_MARK_NAG[n.posMark]);
    } else if (n.posMark) cmds.push(`[%assess ${n.posMark}]`); // no NAGs before the first move
    if (n.attention) cmds.push("[%attention]");
    if (n.cut) cmds.push("[%cut]");
    if (n.analysed && n.score && !locked) {
      const s = n.score;
      cmds.push(`[%eval ${"mate" in s ? "#" + s.mate : (s.cp / 100).toFixed(2)}]`);
    }
    return { nags, comment: [n.comment.trim(), ...cmds].filter(Boolean).join(" ") };
  }

  $(".ag-export").addEventListener("click", () => {
    const d = new Date();
    const tags: [string, string][] = [
      ["Event", analysisName],
      ["Site", "Dark C. Helmet analysis grid"],
      ["Date", `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`],
      ["Round", "-"],
      ["White", "?"],
      ["Black", "?"],
      ["Result", "*"],
    ];
    if (chess960) tags.push(["Variant", "Chess960"]);
    if (root.fen !== START_FEN || chess960) tags.push(["SetUp", "1"], ["FEN", root.fen]);
    const blob = new Blob([writePgn(tags, root, annotate)], { type: "application/x-chess-pgn" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (analysisName.replace(/[^\w\- ]+/g, "").trim() || "analysis") + ".pgn";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  const fileInput = $<HTMLInputElement>(".ag-file");
  $(".ag-import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    const game = parsePgn(await file.text());
    const fen = game.tags.FEN || START_FEN;
    const is960 = /960|fischer/i.test(game.tags.Variant ?? "");
    const name = game.tags.Event && game.tags.Event !== "?" ? game.tags.Event : file.name.replace(/\.pgn$/i, "");
    persistNow();
    if (!startNew(fen, is960, name)) {
      alert("This PGN starts from a position that is not legal.");
      return;
    }
    let skipped = 0;
    readNotes(root, game.root);
    const build = (n: GNode, pm: PgnMove) => {
      for (const pc of pm.children) {
        rules.setFen(n.fen, chess960);
        const legal = rules.moves();
        const want = normalSan(pc.san);
        const m = legal.find((l: LegalMove) => normalSan(san(l, legal)) === want) ?? legal.find((l) => l.uci === pc.san);
        const c = m && child(n, m.uci, "seed");
        if (!c) {
          skipped++;
          continue;
        }
        readNotes(c, pc);
        build(c, pc);
      }
    };
    build(root, game.root);
    await switched();
    if (skipped) alert(`${skipped} move${skipped > 1 ? "s" : ""} in this PGN could not be read and were left out (with what follows them).`);
  });

  /** NAGs and comment commands of a PGN move onto a node. */
  function readNotes(n: GNode, pm: PgnMove): void {
    for (const nag of pm.nags) {
      if (NAG_MOVE.has(nag) && n.parent) n.moveMark = NAG_MOVE.get(nag)!;
      if (NAG_POS.has(nag)) n.posMark = NAG_POS.get(nag)!;
    }
    n.comment = pm.comment
      .replace(/\[%(\w+)\s*([^\]]*)\]/g, (_, cmd: string, arg: string) => {
        arg = arg.trim();
        if (cmd === "attention") n.attention = true;
        else if (cmd === "cut") n.cut = true;
        else if (cmd === "assess" && (POS_MARKS as readonly string[]).includes(arg)) n.posMark = arg as PosMark;
        else if (cmd === "eval") {
          const score: Score | null = arg.startsWith("#") ? { mate: Number(arg.slice(1)) } : Number.isFinite(Number(arg)) ? { cp: Math.round(Number(arg) * 100) } : null;
          if (score && ("mate" in score ? Number.isFinite(score.mate) : true)) {
            n.score = score;
            n.analysed = 1;
          }
        }
        return "";
      })
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---- Engine ----

  /** The app's engine while it is switched on here (null: off, or not loaded yet). */
  let engine: Engine | null = null;
  const syncEngine = () => {
    engine = engineOn ? controller.engine : null;
    if (engineOn && !engine) $(".ag-engine").textContent = engineStatus() ?? "The engine is loading…";
  };
  let generation = 0; // bumped when the tree is replaced: results for the old tree are dropped
  let pumping = false;
  let suggesting = false;
  let suggestRun = 0; // bumped to drop the running suggestions or deep search
  let interrupted = false;
  const priority: (() => Promise<void>)[] = [];

  const toggle = $(".ag-engine-toggle");
  const lockBtn = $<HTMLButtonElement>(".ag-lock");
  function drawEngineToggle(): void {
    toggle.hidden = locked;
    lockBtn.classList.toggle("on", locked);
    lockBtn.textContent = locked ? "Locked: own analysis" : "Lock";
    lockBtn.disabled = locked && gameRunning();
    lockBtn.title = lockBtn.disabled
      ? "Locked while your game against the engine goes on"
      : locked
        ? "No engine and no computed hints in this analysis. Click to unlock."
        : "Lock this analysis as your own (e.g. a correspondence game): no engine, no computed hints";
    if (locked) $(".ag-engine").textContent = "";
    toggle.setAttribute("aria-checked", String(engineOn));
    toggle.textContent = engineOn ? "Engine on" : "Engine off";
    toggle.title = engineOn ? "Switch the engine off: analyse on your own" : "Switch the engine on";
    toggle.classList.toggle("on", engineOn);
  }
  /** Stops everything the engine does for this screen. */
  async function engineOff(): Promise<void> {
    await stopAnalysis();
    engine = null;
    $(".ag-engine").textContent = "";
    suggestions = null;
  }
  lockBtn.addEventListener("click", async () => {
    if (locked && gameRunning()) return;
    if (locked) {
      const ok = confirm(
        "Unlock this analysis? The engine and the computed hints (marks on the boards, threats, notes) can then be used " +
          "again. For a game in which engines are not allowed, keep it locked.",
      );
      if (!ok) return;
      locked = false; // the engine stays off until switched on
    } else {
      locked = true;
      engineOn = false;
      await engineOff();
    }
    persist();
    drawEngineToggle();
    draw();
  });
  toggle.addEventListener("click", async () => {
    if (locked) return;
    engineOn = !engineOn;
    persist();
    drawEngineToggle();
    if (engineOn) {
      syncEngine();
      pump();
    } else {
      // Off means off: nothing runs in the background for this screen.
      await engineOff();
    }
    draw();
  });

  const THREAT_MS = 600;
  /** A threat must win at least this much (centipawns), or mate. */
  const THREAT_GAIN = 120;

  function squareOf(name: string): number {
    return name.charCodeAt(0) - 97 + (name.charCodeAt(1) - 49) * 8;
  }

  /** The threat line under the large board, and its red arrow. */
  function drawThreat(n: GNode, inCheck: boolean): void {
    const box = $(".ag-threat");
    box.className = "ag-threat";
    board.setArrows([]);
    if (!engineOn || n.state !== "ongoing" || inCheck) {
      box.textContent = "";
      return;
    }
    if (n.threat === undefined) {
      box.textContent = "Looking for threats…";
      box.classList.add("muted");
      return;
    }
    if (!n.threat) {
      box.textContent = "No threat";
      box.classList.add("muted");
      return;
    }
    const t = n.threat;
    board.setArrows([{ from: t.from, to: t.to }]);
    const what = t.mate ? `mate in ${t.mate}` : t.win;
    box.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = "Threat: ";
    box.append(strong, `${t.text} — ${what}`);
    box.classList.add("on");
  }

  /** What would the opponent play if it were their move? A threat if it wins clearly. */
  async function findThreat(n: GNode): Promise<void> {
    rules.setFen(n.fen, chess960);
    const nullFen = rules.nullFen();
    if (!nullFen) {
      n.threat = null;
      return;
    }
    const gen = generation;
    interrupted = false;
    const r = await evaluate(nullFen, THREAT_MS);
    if (gen !== generation || interrupted) return; // looked at again later
    if (!r || !r.pv.length) {
      n.threat = null;
      return;
    }
    const whiteToMove = n.fen.split(" ")[1] === "w"; // the threat comes from the other side
    const s = r.score;
    const mate = "mate" in s && (whiteToMove ? s.mate < 0 : s.mate > 0) ? Math.abs(s.mate) : null;
    const gain = whiteToMove ? scoreValue(n.score) - scoreValue(s) : scoreValue(s) - scoreValue(n.score);
    if (!mate && gain < THREAT_GAIN) {
      n.threat = null;
      return;
    }
    // Follow the line while it is forcing (checks, captures, the replies to them; 10 plies at
    // most), or to the mate; the text shows exactly that part, the material is counted there.
    rules.setFen(nullFen, chess960);
    const flags: LineMove[] = [];
    for (const u of r.pv.slice(0, 10)) {
      const m = rules.moves().find((l) => l.uci === u);
      if (!m || !rules.play(u)) break;
      flags.push({ capture: m.capture, check: m.check });
    }
    const plies = mate ? Math.min(flags.length, 2 * mate - 1) : forcingEnd(flags);
    const shown = r.pv.slice(0, plies);
    rules.setFen(nullFen, chess960);
    for (const u of shown) rules.play(u);
    const win = describeWin(placementFromFen(nullFen), placementFromFen(rules.fen()), whiteToMove);
    // Only threats we can name: mate, or material won. (The evaluation swing alone is not
    // enough: it also counts what the side to move loses by passing.)
    if (!mate && !win) {
      n.threat = null;
      return;
    }
    n.threat = {
      from: squareOf(r.pv[0].slice(0, 2)), to: squareOf(r.pv[0].slice(2, 4)),
      text: sanLine(nullFen, shown), mate, win,
    };
  }

  /** Positions that get a deep search: played by hand, or marked for attention. */
  function wantsDeep(n: GNode): boolean {
    return n.attention || n.origin === "user";
  }

  /** `n` or a move before it is marked "not needed": no engine time for it. */
  function isCut(n: GNode): boolean {
    for (let p: GNode | null = n; p; p = p.parent) if (p.cut) return true;
    return false;
  }

  function needsWork(n: GNode): boolean {
    // Lines marked "not needed" get no engine time, unless the player looks at one.
    if (n !== selected && isCut(n)) return false;
    return n.state === "ongoing" && (n.analysed === 0 || (wantsDeep(n) && n.analysed < 2));
  }

  function setEngineStatus(): void {
    if (!engine) return;
    let todo = 0;
    walk(root, (n) => needsWork(n) && todo++);
    $(".ag-engine").textContent = suggesting ? (suggestions?.deep?.running ? "deep search…" : "looking for moves…") : todo ? `${todo} board${todo > 1 ? "s" : ""} to analyse` : "idle";
  }

  /** Next board for the background analysis: the selected one first, then quick looks at all
   *  boards (nearest to the root first), then the deep searches. */
  function nextJob(): { node: GNode; deep: boolean } | null {
    if (needsWork(selected)) return { node: selected, deep: wantsDeep(selected) };
    let quick: GNode | null = null;
    let deep: GNode | null = null;
    walk(root, (n) => {
      if (n.state !== "ongoing") return;
      if (wantsDeep(n) && n.analysed < 2 && (!deep || n.ply < deep.ply)) deep = n;
      if (n.analysed === 0 && (!quick || n.ply < quick.ply)) quick = n;
    });
    const d = deep as GNode | null;
    const q = quick as GNode | null;
    if (q) return { node: q, deep: false };
    if (d) return { node: d, deep: true };
    return null;
  }

  interface Evaluation {
    score: Score;
    depth: number;
    pv: string[];
    /** Positions searched, and the time it took (ms). */
    nodes: number;
    time: number;
    result: SearchResult;
  }

  /** A deep search of a board also teaches the opening book (standard chess from the start
   *  position, up to the book's move limit: `record` checks the range), the best move of the
   *  position and the score of the move that led to it. Quick looks are too shallow. */
  function teachBook(node: GNode, r: SearchResult): void {
    if (chess960 || root.fen !== START_FEN || !r.info || !r.bestmove) return;
    const path: string[] = [];
    for (let n: GNode | null = node; n && n.uci; n = n.parent) path.unshift(n.uci);
    const game = new Game(rules, START_FEN, false);
    for (const uci of path) if (!game.play(uci)) return;
    void record(game, r, engine!, "analysis");
    void recordMoveLeadingHere(game, r, engine!, "analysis");
  }

  async function evaluate(fen: string, ms: number): Promise<Evaluation | null> {
    const r = await engine!.search({ startFen: fen, moves: [], chess960 }, { movetime: ms }, undefined, false);
    if (!r.info) return null;
    return {
      score: whiteScore(r.info.score, fen.split(" ")[1] === "w"), depth: r.info.depth, pv: r.info.pv, nodes: r.nodes, time: r.time, result: r,
    };
  }

  async function pump(): Promise<void> {
    if (!engine || pumping) return;
    pumping = true;
    try {
      for (;;) {
        if (!engine) break;
        setEngineStatus();
        const task = priority.shift();
        if (task) {
          await task();
          continue;
        }
        // The selected board's threat, once the engine has looked at the board itself.
        if (selected.threat === undefined && selected.state === "ongoing" && selected.analysed > 0 && !needsWork(selected)) {
          await findThreat(selected);
          draw();
          continue;
        }
        const job = nextJob();
        if (!job) break;
        const gen = generation;
        interrupted = false;
        const r = await evaluate(job.node.fen, job.deep ? DEEP_MS : QUICK_MS);
        if (gen !== generation || interrupted) continue;
        if (r) {
          job.node.score = r.score;
          job.node.depth = r.depth;
          if (job.deep) teachBook(job.node, r.result);
        }
        job.node.analysed = job.deep ? 2 : (Math.max(job.node.analysed, 1) as 1 | 2);
        persist();
        draw();
      }
    } finally {
      pumping = false;
      setEngineStatus();
    }
  }

  async function stopAnalysis(): Promise<void> {
    generation++;
    priority.length = 0;
    suggesting = false;
    await engine?.stop();
  }


  // ---- Suggestions ----

  interface Candidate {
    uci: string;
    san: string;
    score: Score;
    depth: number;
    pv: string[];
    pvSan: string[];
    inTree: boolean;
    chosen: boolean;
    /** Found by the deep search; `isNew`: not among the moves suggested before it. */
    deep?: boolean;
    isNew?: boolean;
  }
  /** How long and how deep the engine thought for a set of suggestions. */
  interface Effort {
    /** Thinking time per move in the scan and per candidate in the check (ms). */
    scanMs: number;
    checkMs: number;
    /** Legal moves looked at. */
    moves: number;
    /** In all: time (ms) and positions searched. */
    time: number;
    nodes: number;
    /** Depth reached by the candidates' searches. */
    depthMin: number;
    depthMax: number;
  }

  interface Suggestions {
    node: GNode;
    list: Candidate[];
    progress: string;
    /** Thinking time relative to the first round: 1, 2, 4, … */
    factor: number;
    effort: Effort | null;
    /** The best move of the round before, when a deeper round changed it. */
    bestBefore: string | null;
    /** The deep search: running, or how far the last one went. */
    deep?: { running: boolean; started: number; info: SearchInfo | null };
  }
  let suggestions: Suggestions | null = null;

  /** Moves in SAN with move numbers ("12… Nxe4 13. Qd2 Nxd2"). */
  function sanLine(fen: string, ucis: string[]): string {
    rules.setFen(fen, chess960);
    const words: string[] = [];
    for (const u of ucis) {
      const f = rules.fen();
      const legal = rules.moves();
      const m = legal.find((l) => l.uci === u);
      if (!m) break;
      const white = f.split(" ")[1] === "w";
      words.push(white || !words.length ? `${moveNumber(f)} ${san(m, legal)}` : san(m, legal));
      rules.play(u);
    }
    return words.join(" ");
  }

  function pvToSan(fen: string, pv: string[], max: number): string[] {
    rules.setFen(fen, chess960);
    const out: string[] = [];
    for (const u of pv.slice(0, max)) {
      const legal = rules.moves();
      const m = legal.find((l: LegalMove) => l.uci === u);
      if (!m) break;
      out.push(san(m, legal));
      rules.play(u);
    }
    return out;
  }

  $(".ag-suggest").addEventListener("click", () => startSuggest(selected, 1));
  $(".ag-deep").addEventListener("click", () => startDeep(selected));

  /** Time of a round of suggestions, relative to the first: the look at every move grows with
   *  the square root of `factor`, the check of the best few with `factor` itself. */
  function roundCost(factor: number, moves: number): number {
    return moves * SUGGEST_SCAN_MS * Math.sqrt(factor) + Math.min(SUGGEST_COUNT, moves) * SUGGEST_DEEP_MS * factor;
  }

  /** Starts the deep search of `node`: one search, until stopped. Its move joins the
   *  suggestions (the ones there stay). */
  function startDeep(node: GNode): void {
    if (!engine || suggesting) return;
    const before = suggestions?.node === node ? suggestions : null;
    suggesting = true;
    suggestions = {
      node, list: before?.list ?? [], progress: "", factor: before?.factor ?? 0, effort: before?.effort ?? null,
      bestBefore: null, deep: { running: true, started: performance.now(), info: null },
    };
    draw();
    priority.push(() => deepSearch(node));
    if (pumping) {
      interrupted = true;
      engine.stop();
    }
    pump();
  }

  async function deepSearch(node: GNode): Promise<void> {
    const gen = generation;
    const run = suggestRun;
    const s = suggestions;
    if (!s?.deep) return;
    const deep = s.deep;
    const tick = window.setInterval(() => drawDeepProgress(), 1000);
    try {
      const r = await engine!.search({ startFen: node.fen, moves: [], chess960 }, { infinite: true }, (info) => {
        if (info.pv.length) deep.info = info;
        drawDeepProgress();
      }, false);
      if (gen !== generation || run !== suggestRun) return;
      const info = r.info ?? deep.info;
      if (r.info?.pv.length) deep.info = r.info;
      teachBook(node, r);
      const uci = r.bestmove ?? info?.pv[0];
      if (info && uci) {
        const whiteToMove = node.fen.split(" ")[1] === "w";
        rules.setFen(node.fen, chess960);
        const legal = rules.moves();
        const m = legal.find((l) => l.uci === uci);
        if (m) {
          rules.play(uci);
          const after = rules.fen();
          const pv = info.pv[0] === uci ? info.pv.slice(1) : [];
          const old = s.list.find((c) => c.uci === uci);
          const cand: Candidate = {
            uci, san: san(m, legal), score: whiteScore(info.score, whiteToMove), depth: info.depth, pv,
            pvSan: pvToSan(after, pv, PV_PLIES - 1), inTree: node.children.some((c) => c.uci === uci),
            chosen: old?.chosen ?? false, deep: true, isNew: !old && s.list.length > 0,
          };
          s.list = [cand, ...s.list.filter((c) => c.uci !== uci)];
          // Boards already in the grid along its line take the new evaluation right away.
          if (takeLine(node, [uci, ...pv], cand.score, cand.depth)) persist();
        }
      }
    } finally {
      window.clearInterval(tick);
      deep.running = false;
      deep.info = deep.info ? { ...deep.info, time: performance.now() - deep.started } : null;
      if (gen === generation) suggesting = false;
      draw();
    }
  }

  /** Updates the running deep search's line in place (no redraw of the whole panel). */
  function drawDeepProgress(): void {
    const el = document.querySelector<HTMLElement>(".ag-deep-progress");
    const d = suggestions?.deep;
    if (!el || !d || !suggestions) return;
    el.replaceChildren(...deepLines(suggestions.node, d));
  }

  function deepLines(node: GNode, d: NonNullable<Suggestions["deep"]>): HTMLElement[] {
    const head = document.createElement("p");
    head.className = "ag-effort muted";
    const time = d.running ? performance.now() - d.started : (d.info?.time ?? 0);
    const parts = [`${d.running ? "Deep search running" : "Deep search"}: ${seconds(time)}`];
    if (d.info) parts.push(`depth ${d.info.depth}`, `${formatCount(d.info.nodes)} nodes`);
    head.textContent = parts.join(" · ");
    if (!d.running || !d.info) return [head];
    const best = document.createElement("p");
    const whiteToMove = node.fen.split(" ")[1] === "w";
    const line = sanLine(node.fen, d.info.pv.slice(0, PV_PLIES));
    const ev = document.createElement("strong");
    ev.className = "numeric";
    ev.textContent = scoreText(whiteScore(d.info.score, whiteToMove), "ongoing");
    best.append("Best so far: ", ev, ` ${line}`);
    return [head, best];
  }

  /** Starts a round of suggestions for `node`, thinking `factor` times as long as the first
   *  round. The moves already ticked stay ticked. */
  function startSuggest(node: GNode, factor: number): void {
    if (!engine || suggesting) return;
    const before = suggestions?.node === node ? suggestions : null;
    suggesting = true;
    suggestions = {
      node, list: before?.list ?? [], progress: "Looking at every move…", factor, effort: null, bestBefore: null,
    };
    draw();
    priority.push(() => suggest(node, factor, before));
    if (pumping) {
      interrupted = true; // cut the running background search short; it is done again later
      engine.stop();
    }
    pump();
  }

  async function suggest(node: GNode, factor: number, before: Suggestions | null): Promise<void> {
    const gen = generation;
    const run = suggestRun;
    const scanMs = Math.round(SUGGEST_SCAN_MS * Math.sqrt(factor));
    const checkMs = SUGGEST_DEEP_MS * factor;
    const effort: Effort = { scanMs, checkMs, moves: 0, time: 0, nodes: 0, depthMin: Infinity, depthMax: 0 };
    const count = (r: Evaluation | null) => {
      if (!r) return;
      effort.time += r.time;
      effort.nodes += r.nodes;
    };
    const deeper = factor > 1 ? ` (${factor}× the first round's time)` : "";
    try {
      rules.setFen(node.fen, chess960);
      const legal = rules.moves();
      effort.moves = legal.length;
      const whiteToMove = node.fen.split(" ")[1] === "w";
      const better = (a: Score, b: Score) => (whiteToMove ? scoreValue(b) - scoreValue(a) : scoreValue(a) - scoreValue(b));
      // 1. A short search after every legal move.
      const scan: { m: LegalMove; fen: string; score: Score }[] = [];
      for (const [i, m] of legal.entries()) {
        rules.setFen(node.fen, chess960);
        rules.play(m.uci);
        const fen = rules.fen();
        const state = rules.state();
        let score: Score;
        if (state === "checkmate") score = { mate: whiteToMove ? 1 : -1 };
        else if (state !== "ongoing") score = { cp: 0 };
        else {
          const r = await evaluate(fen, scanMs);
          if (gen !== generation || run !== suggestRun) return;
          count(r);
          score = r?.score ?? { cp: 0 };
        }
        scan.push({ m, fen, score });
        if (suggestions?.node === node) suggestions.progress = `Looking at every move${deeper}… ${i + 1}/${legal.length}`;
        drawSuggestions();
      }
      scan.sort((a, b) => better(a.score, b.score));
      // 2. A longer search for the best few, with the line the engine expects.
      const list: Candidate[] = [];
      for (const [i, s] of scan.slice(0, SUGGEST_COUNT).entries()) {
        if (suggestions?.node === node) suggestions.progress = `Checking the best moves${deeper}… ${i + 1}/${Math.min(SUGGEST_COUNT, scan.length)}`;
        drawSuggestions();
        let score = s.score;
        let pv: string[] = [];
        let depth = 0;
        rules.setFen(s.fen, chess960);
        if (rules.state() === "ongoing") {
          const r = await evaluate(s.fen, checkMs);
          if (gen !== generation || run !== suggestRun) return;
          count(r);
          if (r) {
            ({ score, pv, depth } = r);
            effort.depthMin = Math.min(effort.depthMin, depth);
            effort.depthMax = Math.max(effort.depthMax, depth);
          }
        }
        const inTree = node.children.some((c) => c.uci === s.m.uci);
        const chosen = !!before?.list.some((c) => c.uci === s.m.uci && c.chosen);
        list.push({
          uci: s.m.uci, san: san(s.m, legal), score, depth, pv, pvSan: pvToSan(s.fen, pv, PV_PLIES - 1), inTree, chosen,
        });
      }
      // A move the deep search found stays, also when this round did not check it, with
      // the deeper of the two results.
      for (const c of before?.list ?? []) {
        if (!c.deep) continue;
        const i = list.findIndex((l) => l.uci === c.uci);
        if (i < 0) list.push({ ...c, isNew: false });
        else if (c.depth >= list[i].depth) list[i] = { ...c, chosen: list[i].chosen, isNew: false };
      }
      list.sort((a, b) => better(a.score, b.score));
      if (effort.depthMin === Infinity) effort.depthMin = 0;
      const oldBest = before?.list[0];
      const bestBefore = oldBest && list[0] && oldBest.uci !== list[0].uci ? oldBest.san : null;
      if (suggestions?.node === node) suggestions = { node, list, progress: "", factor, effort, bestBefore, deep: before?.deep };
    } finally {
      if (gen === generation) suggesting = false;
      draw();
    }
  }

  /** A search's line through boards already in the grid: every position on the engine's main
   *  line has its value, so each board on it takes the evaluation, one ply less deep per move
   *  (if that is at least as deep as what the board has). Returns whether anything changed. */
  function takeLine(from: GNode, ucis: string[], score: Score, depth: number): boolean {
    let changed = false;
    let n: GNode | undefined = from;
    for (const [k, u] of ucis.entries()) {
      n = n.children.find((c) => c.uci === u);
      const d = depth - k;
      if (!n || d < 1) break;
      if (takeEval(n, score, d)) changed = true;
    }
    return changed;
  }

  /** A suggested move that is already in the grid: its board takes the new evaluation (if
   *  the search went at least as deep), and the line goes on along the moves already there;
   *  what is new is added folded, like any suggested line. */
  function mergeLine(from: GNode, c: Candidate): void {
    let n = from.children.find((k) => k.uci === c.uci);
    if (!n) return;
    takeLine(from, [c.uci, ...c.pv], c.score, c.depth);
    const pv = c.pv.slice(0, PV_PLIES - 1);
    let i = 0;
    for (; i < pv.length; i++) {
      const next: GNode | undefined = n.children.find((k) => k.uci === pv[i]);
      if (!next) break;
      n = next;
    }
    const rest = pv.slice(i);
    if (!rest.length) return;
    if (!n.children.length) {
      // The end of a line: the new moves fold after it (a longer folded line on the same
      // moves stays).
      if (n.ghost && rest.every((u, k) => n!.ghost!.ucis[k] === u)) return;
      n.ghost = makeGhost(n, rest, c.score, c.depth - (i + 1));
      return;
    }
    // The line leaves the grid's moves here: a new alternative, folded after its first move.
    const alt = child(n, rest[0], "engine");
    if (!alt) return;
    n.expanded = true;
    takeEval(alt, c.score, c.depth - (i + 1));
    if (rest.length > 1 && !alt.children.length) alt.ghost = makeGhost(alt, rest.slice(1), c.score, c.depth - (i + 2));
  }

  function drawSuggestions(): void {
    const box = $(".ag-suggestions");
    const s = suggestions;
    box.replaceChildren();
    if (!s || s.node !== selected) return;
    if (s.progress) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = s.progress;
      box.append(p);
      return;
    }
    if (s.deep?.running) {
      const prog = document.createElement("div");
      prog.className = "ag-deep-progress";
      prog.append(...deepLines(s.node, s.deep));
      const stop = document.createElement("button");
      stop.className = "btn-primary";
      stop.textContent = "Stop";
      stop.title = "Stop the deep search; its move joins the suggestions";
      stop.addEventListener("click", () => {
        stop.disabled = true;
        engine?.stop();
      });
      const buttons = document.createElement("div");
      buttons.className = "ag-nav";
      buttons.append(stop);
      box.append(prog, buttons);
      return;
    }
    if (!s.list.length) return;
    const title = document.createElement("p");
    title.innerHTML = "<strong>Engine suggestions</strong> — pick the ones worth a row:";
    box.append(title);
    if (s.effort) {
      const e = s.effort;
      const info = document.createElement("p");
      info.className = "ag-effort muted";
      const depth = e.depthMin === e.depthMax ? `depth ${e.depthMax}` : `depth ${e.depthMin}–${e.depthMax}`;
      info.textContent =
        `The engine thought ${seconds(e.time)} in all: ${seconds(e.scanMs)} on every move, then ` +
        `${seconds(e.checkMs)} on each of the best ${s.list.length} (${depth}) · ${formatCount(e.nodes)} nodes`;
      box.append(info);
    }
    if (s.deep) box.append(...deepLines(s.node, s.deep));
    if (s.bestBefore) {
      const changed = document.createElement("p");
      changed.className = "ag-effort-changed";
      changed.textContent = `Thinking longer changed the best move (before: ${s.bestBefore}).`;
      box.append(changed);
    }
    const ul = document.createElement("ul");
    ul.className = "ag-cands";
    for (const c of s.list) {
      const li = document.createElement("li");
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = c.chosen;
      cb.addEventListener("change", () => (c.chosen = cb.checked));
      const mv = document.createElement("span");
      mv.className = "ag-cand-move";
      mv.textContent = `${moveNumber(s.node.fen)} ${c.san}`;
      const ev = document.createElement("span");
      ev.className = "ag-cand-eval numeric";
      ev.textContent = scoreText(c.score, "ongoing");
      if (c.depth) ev.title = `depth ${c.depth}`;
      const line = document.createElement("span");
      line.className = "ag-cand-pv muted";
      line.textContent = (c.pvSan.join(" ") || "") + (c.inTree ? " (in the grid: tick to add what is new and update the evaluation)" : "");
      if (c.deep) {
        const tag = document.createElement("span");
        tag.className = "ag-cand-tag" + (c.isNew ? " new" : "");
        tag.textContent = c.isNew ? "new · deep" : "deep";
        tag.title = c.isNew ? "Found by the deep search; not among the suggestions before" : "Found by the deep search";
        mv.append(" ", tag);
      }
      label.append(cb, mv, ev, line);
      li.append(label);
      ul.append(li);
    }
    box.append(ul);
    const add = document.createElement("button");
    add.className = "btn-primary";
    add.textContent = "Add the chosen lines";
    add.addEventListener("click", () => {
      // One real board per chosen move; the engine's continuation stays folded (a ghost).
      for (const c of s.list) {
        if (!c.chosen) continue;
        if (c.inTree) {
          mergeLine(s.node, c);
          continue;
        }
        const n = child(s.node, c.uci, "engine");
        if (n) takeLine(s.node, [c.uci], c.score, c.depth); // the search's evaluation, not a new quick look
        if (n && c.pv.length && !n.children.length) n.ghost = makeGhost(n, c.pv.slice(0, PV_PLIES - 1), c.score, c.depth - 1);
      }
      s.node.expanded = true;
      suggestions = null;
      persist();
      draw();
      pump();
    });
    const deeper = document.createElement("button");
    deeper.className = "btn-secondary";
    const next = Math.max(1, s.factor * DEEPER_STEP);
    const e = s.effort;
    const estimate = e && s.factor ? ` (about ${seconds((e.time * roundCost(next, e.moves)) / roundCost(s.factor, e.moves))})` : "";
    deeper.textContent = `${s.factor ? "Think deeper" : "Suggest moves"}${estimate}`;
    deeper.title = s.factor
      ? "Compare the moves again with about three times the time; the ticked moves stay ticked"
      : "Look at the alternatives too; the deep search's move stays";
    deeper.disabled = suggesting || !engine;
    deeper.addEventListener("click", () => startSuggest(s.node, next));
    const deepAgain = document.createElement("button");
    deepAgain.className = "btn-secondary";
    deepAgain.textContent = "Deep search";
    deepAgain.title = "One search of the position, as deep as you let it run";
    deepAgain.disabled = suggesting || !engine;
    deepAgain.addEventListener("click", () => startDeep(s.node));
    const buttons = document.createElement("div");
    buttons.className = "ag-nav";
    buttons.append(add, deeper, deepAgain);
    box.append(buttons);
  }

  function seconds(ms: number): string {
    if (ms < 1000) return `${(ms / 1000).toFixed(2).replace(/0$/, "")} s`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
  }

  function formatCount(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} billion`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} million`;
    if (n >= 1e3) return `${Math.round(n / 1e3)} thousand`;
    return String(n);
  }

  showName();
  drawEngineToggle();
  persist();
  draw();
  syncEngine();
  pump();
  // The engine may still be loading when the screen opens.
  const unsubscribe = controller.subscribe(() => {
    if (engineOn && !engine && controller.engine) {
      syncEngine();
      draw();
      pump();
    }
  });

  return () => {
    generation++; // results still coming in are dropped
    priority.length = 0;
    suggesting = false;
    engine?.stop();
    engine = null;
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", onMenuAway, true);
    window.removeEventListener("blur", closeMenu);
    window.removeEventListener("resize", closeMenu);
    window.removeEventListener("resize", onResize);
    menu.remove();
    unsubscribe();
    persistNow();
    document.title = originalTitle;
  };
}
