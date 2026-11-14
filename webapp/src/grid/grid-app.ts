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
import type { Engine } from "../engine/engine.ts";
import type { PlayController } from "../play/controller.ts";
import { settings } from "../settings.ts";
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
  MOVE_MARK_NAG, MOVE_MARK_TITLE, MOVE_MARKS, POS_MARK_NAG, POS_MARK_TITLE, POS_MARKS, scoreText, scoreValue, walk,
  whiteScore, type Ghost, type GNode, type MoveMark, type Origin, type PosMark, type Score,
} from "./tree.ts";
import "./grid.css";

const QUICK_MS = 250;
const DEEP_MS = 2000;
const SUGGEST_SCAN_MS = 80;
const SUGGEST_DEEP_MS = 700;
const SUGGEST_COUNT = 6;
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
  function makeGhost(n: GNode, ucis: string[], score: Score | null): Ghost | null {
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
    return { ucis: played, text: words.join(" "), fen: rules.fen(), state: rules.state(), score, ...last };
  }

  /** Turns a ghost into real boards: the whole line, or its next move (the ghost moves on).
   *  The next move becomes the selected board, so it is shown large in the panel. */
  function unfold(n: GNode, all: boolean): void {
    const g = n.ghost;
    if (!g) return;
    n.ghost = null;
    n.expanded = true;
    let next: GNode | null = null;
    if (all) addLine(n, g.ucis, "engine");
    else {
      next = child(n, g.ucis[0], "engine");
      if (next && g.ucis.length > 1 && !next.ghost && !next.children.length) next.ghost = makeGhost(next, g.ucis.slice(1), g.score);
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
      ghost: n.ghost ? { ucis: n.ghost.ucis, score: n.ghost.score } : undefined,
    };
  }

  function applySaved(n: GNode, s: SavedNode): void {
    Object.assign(n, {
      score: s.score, analysed: s.analysed, depth: s.depth, expanded: s.expanded, attention: s.attention ?? s.toCheck ?? false,
      comment: s.comment ?? "", moveMark: s.moveMark ?? null, posMark: s.posMark ?? null,
    });
    if (s.ghost) n.ghost = makeGhost(n, s.ghost.ucis, s.ghost.score);
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
      engineOn, locked,
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
  if (fromFen) {
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
      <aside class="ag-panel">
        <div class="ag-board"></div>
        <div class="ag-info">
          <div class="ag-line"><span class="ag-move"></span><span class="ag-score numeric"></span></div>
          <div class="ag-status muted"></div>
          <div class="ag-threat"></div>
        </div>
        <div class="ag-nav">
          <button class="ag-back btn-secondary" title="Previous move (←)">◀</button>
          <button class="ag-fwd btn-secondary" title="Next move (→)">▶</button>
          <button class="ag-suggest btn-secondary">Suggest moves</button>
          <button class="ag-attention" aria-pressed="false">Needs attention</button>
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

  const grid = new GridView({
    select: (n) => select(n),
    toggle: (n) => {
      n.expanded = !n.expanded;
      persist();
      draw();
    },
    unfold: (n, all) => unfold(n, all),
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
    if (n !== selected) suggestions = null;
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
      drawPanel();
    });
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
    $(".ag-score").textContent = [n.posMark ?? "", engineOn ? scoreText(n.score, n.state) : ""].filter(Boolean).join("  ");
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
    drawSuggestions();
  }

  // ---- Panel actions ----

  $(".ag-back").addEventListener("click", () => selected.parent && select(selected.parent));
  $(".ag-fwd").addEventListener("click", () => selected.children[0] && select(selected.children[0]));
  $(".ag-attention").addEventListener("click", () => {
    selected.attention = !selected.attention;
    persist();
    draw();
    pump();
  });
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
  $(".ag-main-line").addEventListener("click", () => {
    const p = selected.parent;
    if (!p) return;
    p.children.splice(p.children.indexOf(selected), 1);
    p.children.unshift(selected);
    persist();
    draw();
  });
  $(".ag-delete").addEventListener("click", () => {
    const p = selected.parent;
    if (!p) return;
    let count = 0;
    walk(selected, () => count++);
    if (!confirm(`Delete ${selected.moveNo} ${selected.san} and ${count - 1} board${count === 2 ? "" : "s"} after it?`)) return;
    p.children.splice(p.children.indexOf(selected), 1);
    persist();
    select(p);
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (document.querySelector("dialog[open]")) return;
    if (e.key === "ArrowLeft" && selected.parent) select(selected.parent);
    else if (e.key === "ArrowRight" && selected.children[0]) select(selected.children[0]);
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
  let interrupted = false;
  const priority: (() => Promise<void>)[] = [];

  const toggle = $(".ag-engine-toggle");
  const lockBtn = $(".ag-lock");
  function drawEngineToggle(): void {
    toggle.hidden = locked;
    lockBtn.classList.toggle("on", locked);
    lockBtn.textContent = locked ? "Locked: own analysis" : "Lock";
    lockBtn.title = locked
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

  function needsWork(n: GNode): boolean {
    return n.state === "ongoing" && (n.analysed === 0 || (wantsDeep(n) && n.analysed < 2));
  }

  function setEngineStatus(): void {
    if (!engine) return;
    let todo = 0;
    walk(root, (n) => needsWork(n) && todo++);
    $(".ag-engine").textContent = suggesting ? "looking for moves…" : todo ? `${todo} board${todo > 1 ? "s" : ""} to analyse` : "idle";
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
  }

  async function evaluate(fen: string, ms: number): Promise<Evaluation | null> {
    const r = await engine!.search({ startFen: fen, moves: [], chess960 }, { movetime: ms }, undefined, false);
    if (!r.info) return null;
    return {
      score: whiteScore(r.info.score, fen.split(" ")[1] === "w"), depth: r.info.depth, pv: r.info.pv, nodes: r.nodes, time: r.time,
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
  }
  /** How long and how deep the engine thought for a set of suggestions. */
  interface Effort {
    /** Thinking time per move in the scan and per candidate in the check (ms). */
    scanMs: number;
    checkMs: number;
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
    const scanMs = SUGGEST_SCAN_MS * factor;
    const checkMs = SUGGEST_DEEP_MS * factor;
    const effort: Effort = { scanMs, checkMs, time: 0, nodes: 0, depthMin: Infinity, depthMax: 0 };
    const count = (r: Evaluation | null) => {
      if (!r) return;
      effort.time += r.time;
      effort.nodes += r.nodes;
    };
    const deeper = factor > 1 ? ` (${factor}× the first round's time)` : "";
    try {
      rules.setFen(node.fen, chess960);
      const legal = rules.moves();
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
          if (gen !== generation) return;
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
          if (gen !== generation) return;
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
      list.sort((a, b) => better(a.score, b.score));
      if (effort.depthMin === Infinity) effort.depthMin = 0;
      const oldBest = before?.list[0];
      const bestBefore = oldBest && list[0] && oldBest.uci !== list[0].uci ? oldBest.san : null;
      if (suggestions?.node === node) suggestions = { node, list, progress: "", factor, effort, bestBefore };
    } finally {
      if (gen === generation) suggesting = false;
      draw();
    }
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
      cb.checked = c.chosen || c.inTree;
      cb.disabled = c.inTree;
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
      line.textContent = (c.pvSan.join(" ") || "") + (c.inTree ? " (already in the grid)" : "");
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
        if (!c.chosen || c.inTree) continue;
        const n = child(s.node, c.uci, "engine");
        if (n && c.pv.length && !n.children.length) n.ghost = makeGhost(n, c.pv.slice(0, PV_PLIES - 1), c.score);
      }
      s.node.expanded = true;
      suggestions = null;
      persist();
      draw();
      pump();
    });
    const deeper = document.createElement("button");
    deeper.className = "btn-secondary";
    const estimate = s.effort ? ` (about ${seconds(s.effort.time * 2)})` : "";
    deeper.textContent = `Think deeper${estimate}`;
    deeper.title = "Search again with twice the time; the ticked moves stay ticked";
    deeper.disabled = suggesting || !engine;
    deeper.addEventListener("click", () => startSuggest(s.node, s.factor * 2));
    const buttons = document.createElement("div");
    buttons.className = "ag-nav";
    buttons.append(add, deeper);
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
    unsubscribe();
    persistNow();
    document.title = originalTitle;
  };
}
