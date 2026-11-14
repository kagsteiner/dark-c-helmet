// Draws the tree as a grid of small boards: one column per ply, one row per line. Each board
// has an evaluation bar on its left, as in broadcasts: black on top, white from the bottom,
// half and half at 0.0: the engine's, or with the engine off the player's own assessment
// (hatched).
// Analysis marks sit on the board itself; below it: the move with the player's mark, the
// assessment, the extra material and a comment sign.
import { placementFromFen, type Placement } from "../chess/fen.ts";
import { pieceUrl } from "../ui/board.ts";
import { features, type Features, type PieceType } from "./features.ts";
import { overMarks, underMarks } from "./marks.ts";
import {
  alternatives, barFraction, layout, MOVE_MARK_TITLE, POS_MARK_BAR, POS_MARK_TITLE, scoreText, type Cell, type GNode,
} from "./tree.ts";

export interface GridCallbacks {
  select(node: GNode): void;
  toggle(node: GNode): void;
  /** Turns a node's ghost into real boards: the whole line, or only its next move. */
  unfold(node: GNode, all: boolean): void;
  /** Squares of pieces lost in the exchange (rules module). */
  hanging(fen: string): number[];
}

const BAR = 7; // evaluation bar width
const BAR_GAP = 3;
const LABEL = 42; // move label and second line below the board
const GAP_X = 16;
const GAP_Y = 26; // room above each board for the alternatives badge
/** Below this board size only the king glow is drawn, not the pawn marks. */
const SMALL = 72;
/** A ghost board is this much smaller than a real one; the room on its left holds the
 *  "N moves" pill on the connector. */
const GHOST_SCALE = 0.72;

export class GridView {
  readonly el: HTMLElement;
  private inner: HTMLElement;
  private svg: SVGSVGElement;
  size = 96;
  engineOn = true;
  private cb: GridCallbacks;
  private cache = new Map<string, { placement: Placement; fx: Features; hanging: number[] }>();

  constructor(cb: GridCallbacks) {
    this.cb = cb;
    this.el = document.createElement("div");
    this.el.className = "grid-scroll";
    this.inner = document.createElement("div");
    this.inner.className = "grid-inner";
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("class", "grid-lines");
    this.inner.append(this.svg);
    this.el.append(this.inner);
  }

  private get cellW(): number {
    return BAR + BAR_GAP + this.size + GAP_X;
  }

  private get cellH(): number {
    return this.size + LABEL + GAP_Y;
  }

  private analysis(fen: string): { placement: Placement; fx: Features; hanging: number[] } {
    let a = this.cache.get(fen);
    if (!a) {
      const placement = placementFromFen(fen);
      a = { placement, fx: features(placement), hanging: this.cb.hanging(fen) };
      this.cache.set(fen, a);
    }
    return a;
  }

  render(root: GNode, selected: GNode): void {
    const { cells, rows, cols } = layout(root);
    const W = this.cellW;
    const H = this.cellH;
    const S = this.size;
    const width = cols * W;
    const height = rows.length * H;
    this.inner.style.width = width + "px";
    this.inner.style.height = height + "px";
    this.inner.style.setProperty("--mb", S + "px");
    this.inner.classList.toggle("small", S < SMALL);

    const path = new Set<GNode>();
    for (let n: GNode | null = selected; n; n = n.parent) path.add(n);

    // Lines first: within a row, and from a branch point down to the row it starts.
    const boardX = (col: number) => col * W + BAR + BAR_GAP;
    const lines: string[] = [];
    const gb = Math.round(S * GHOST_SCALE);
    const ghostX = (col: number) => col * W + S - gb; // left edge of a ghost's bar
    const at = new Map<GNode, Cell>();
    for (const c of cells) if (!c.ghost) at.set(c.node, c);
    for (const c of cells) {
      if (c.ghost) {
        // A ghost at the end of its node's row: a dashed line from the node.
        const from = at.get(c.node)!;
        if (from.row === c.row) {
          const y = c.row * H + S / 2;
          lines.push(`<line x1="${boardX(from.col) + S}" y1="${y}" x2="${ghostX(c.col)}" y2="${y}" class="ghost-line"/>`);
        }
        continue;
      }
      const next = c.node.children[0];
      const nc = next && at.get(next);
      if (nc && nc.row === c.row) {
        const y = c.row * H + S / 2;
        lines.push(`<line x1="${boardX(c.col) + S}" y1="${y}" x2="${nc.col * W}" y2="${y}" class="${path.has(next) ? "on" : ""}"/>`);
      }
    }
    for (const r of rows) {
      if (!r.from) continue;
      const x = boardX(r.from.col) + S / 2;
      const y1 = r.from.row * H + S + LABEL - 4;
      const y2 = r.row * H + S / 2;
      const first = cells.find((c) => c.row === r.row)!;
      const on = !first.ghost && path.has(first.node);
      const end = first.ghost ? ghostX(r.startCol) : r.startCol * W;
      const cls = first.ghost ? "ghost-line" : on ? "on" : "";
      lines.push(`<path d="M${x} ${y1} V${y2 - 6} Q${x} ${y2} ${x + 6} ${y2} H${end}" class="${cls}"/>`);
    }
    this.svg.setAttribute("width", String(width));
    this.svg.setAttribute("height", String(height));
    this.svg.innerHTML = lines.join("");

    const frag = document.createDocumentFragment();
    for (const c of cells) frag.append(...(c.ghost ? this.ghostCell(c, gb) : [this.cell(c, selected, path)]));
    this.inner.replaceChildren(this.svg, frag);
  }

  private cell(c: Cell, selected: GNode, path: Set<GNode>): HTMLElement {
    const n = c.node;
    const { placement, fx, hanging } = this.analysis(n.fen);
    const el = document.createElement("div");
    el.className = "gc";
    el.dataset.id = String(n.id);
    el.style.left = c.col * this.cellW + "px";
    el.style.top = c.row * this.cellH + "px";
    if (n === selected) el.classList.add("selected");
    else if (path.has(n)) el.classList.add("on-path");
    if (n.attention) el.classList.add("attention");

    el.append(this.bar(n));

    const board = this.miniBoard(n, placement, fx, hanging);
    board.addEventListener("click", () => this.cb.select(n));
    el.append(board);

    const alts = alternatives(n);
    if (alts) {
      const badge = document.createElement("button");
      badge.className = "gc-badge" + (n.expanded ? " open" : "");
      badge.textContent = (n.expanded ? "−" : "+") + alts;
      badge.title = n.expanded ? "Hide the alternatives" : `Show ${alts} alternative${alts > 1 ? "s" : ""}`;
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cb.toggle(n);
      });
      el.append(badge);
    }

    // Line 1, the player's: the move with its mark; the position mark.
    const label = document.createElement("div");
    label.className = "gc-label";
    const move = document.createElement("span");
    move.className = "gc-move" + (n.origin === "engine" ? " from-engine" : "");
    move.textContent = n.uci ? `${n.moveNo} ${n.san}` : "Start";
    if (n.moveMark) {
      const m = document.createElement("span");
      m.className = "gc-move-mark mm-" + markClass(n.moveMark);
      m.textContent = n.moveMark;
      m.title = MOVE_MARK_TITLE[n.moveMark];
      move.append(m);
    }
    label.append(move);
    if (n.posMark) {
      const p = document.createElement("span");
      p.className = "gc-pos-mark";
      p.textContent = n.posMark;
      p.title = "Your assessment: " + POS_MARK_TITLE[n.posMark];
      label.append(p);
    }
    el.append(label);

    el.append(this.second(n, fx));
    return el;
  }

  /** The engine's evaluation, or the player's assessment (hatched) when the engine is off or
   *  has not looked at this board yet. */
  private bar(n: GNode): HTMLElement {
    const whiteToMove = n.fen.split(" ")[1] === "w";
    const bar = document.createElement("div");
    bar.className = "gc-bar";
    let f = 0;
    const engineKnows = this.engineOn && (n.analysed > 0 || n.state !== "ongoing");
    if (engineKnows || n.state !== "ongoing") f = barFraction(n.score, n.state, whiteToMove);
    else if (n.posMark) {
      f = POS_MARK_BAR[n.posMark];
      bar.classList.add("own");
      bar.title = "Your assessment: " + POS_MARK_TITLE[n.posMark];
    } else bar.classList.add("pending");
    if (!bar.classList.contains("pending")) bar.append(whitePart(f));
    return bar;
  }

  private miniBoard(n: GNode, placement: Placement, fx: Features, hanging: number[]): HTMLElement {
    const b = document.createElement("div");
    b.className = "mb";
    const add = (cls: string, sq: number, img?: string) => {
      const d = document.createElement("div");
      d.className = cls;
      d.style.left = (sq & 7) * 12.5 + "%";
      d.style.top = (7 - (sq >> 3)) * 12.5 + "%";
      if (img) d.style.backgroundImage = `url("${img}")`;
      b.append(d);
    };
    if (n.lastMove) {
      add("mb-mark", n.lastMove[0]);
      add("mb-mark", n.lastMove[1]);
    }
    b.append(...underMarks(fx));
    placement.forEach((p, sq) => p && add("mb-p", sq, pieceUrl(p)));
    b.append(...overMarks(fx, hanging));
    return b;
  }

  /** Line 2: mate or draw if that is what the position is about; else the extra material;
   *  and a comment sign. */
  private second(n: GNode, fx: Features): HTMLElement {
    const row = document.createElement("div");
    row.className = "gc-second";
    const mate =
      n.state === "checkmate" ? (n.fen.split(" ")[1] === "w" ? -1 : 1)
        : this.engineOn && n.score && "mate" in n.score ? n.score.mate : 0;
    if (mate) {
      const g = document.createElement("span");
      g.className = "gc-chip " + (mate > 0 ? "white" : "black");
      g.textContent = n.state === "checkmate" ? "Mate" : `Mate in ${Math.abs(mate)}`;
      g.title = n.state === "checkmate" ? "Checkmate" : `${mate > 0 ? "White" : "Black"} mates in ${Math.abs(mate)}`;
      row.append(g);
    } else if (n.state !== "ongoing") {
      const g = document.createElement("span");
      g.className = "gc-chip draw";
      g.textContent = "Draw";
      g.title = n.state;
      row.append(g);
    } else {
      const mat = materialView(fx);
      if (mat) row.append(mat);
    }
    const right = document.createElement("span");
    right.className = "gc-right";
    if (this.engineOn && n.state === "ongoing" && !mate) {
      const ev = document.createElement("span");
      ev.className = "gc-eval numeric";
      ev.textContent = scoreText(n.score, n.state);
      ev.title = n.analysed === 2 ? `Engine, deep search (depth ${n.depth})` : n.analysed ? `Engine, quick look (depth ${n.depth})` : "";
      right.append(ev);
    }
    if (n.comment.trim()) {
      const c = document.createElement("span");
      c.className = "gc-comment";
      c.title = n.comment;
      c.innerHTML = COMMENT_ICON;
      right.append(c);
    }
    row.append(right);
    return row;
  }

  /** A folded engine line: the pill on the connector ("N moves": unfold the next move) and
   *  the faded final position (unfold the whole line). */
  private ghostCell(c: Cell, gb: number): HTMLElement[] {
    const n = c.node;
    const g = n.ghost!;
    const S = this.size;
    const left = c.col * this.cellW;
    const top = c.row * this.cellH;

    const pill = document.createElement("button");
    pill.className = "gc-ghost-pill";
    pill.style.left = left - GAP_X + 2 + "px";
    pill.style.width = GAP_X + S - gb - 4 + "px";
    pill.style.top = top + S / 2 - 15 + "px";
    pill.innerHTML = `<strong>${g.ucis.length}</strong><span>${g.ucis.length === 1 ? "move" : "moves"}</span>`;
    pill.title = `Engine line: ${g.text}\nClick: unfold the next move`;
    pill.addEventListener("click", () => this.cb.unfold(n, false));

    const el = document.createElement("div");
    el.className = "gc ghost";
    el.style.left = left + S - gb + "px";
    el.style.top = top + (S - gb) / 2 + "px";
    el.style.setProperty("--mb", gb + "px");

    const bar = document.createElement("div");
    bar.className = "gc-bar";
    const f = this.engineOn ? barFraction(g.score, g.state, g.fen.split(" ")[1] === "w") : 0;
    if (!this.engineOn) bar.classList.add("pending");
    if (this.engineOn) bar.append(whitePart(f));
    el.append(bar);

    const { placement, fx, hanging } = this.analysis(g.fen);
    const board = this.miniBoard({ ...n, lastMove: g.lastMove }, placement, fx, hanging);
    board.title = `Engine line: ${g.text}\nClick: unfold the whole line`;
    board.addEventListener("click", () => this.cb.unfold(n, true));
    el.append(board);

    const label = document.createElement("div");
    label.className = "gc-label";
    const move = document.createElement("span");
    move.className = "gc-move from-engine";
    move.textContent = `${g.moveNo} ${g.san}`;
    label.append(move);
    if (this.engineOn) {
      const ev = document.createElement("span");
      ev.className = "gc-eval numeric";
      ev.textContent = scoreText(g.score, g.state);
      label.append(ev);
    }
    el.append(label);
    return [pill, el];
  }

  /** Scrolls so the board of this node is visible. */
  reveal(node: GNode): void {
    const el = this.inner.querySelector<HTMLElement>(`.gc[data-id="${node.id}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

/** The white part of a bar, growing from the bottom: half at 0, all at +1. */
function whitePart(f: number): HTMLElement {
  const w = document.createElement("div");
  w.className = "gc-bar-white";
  w.style.height = 50 + f * 50 + "%";
  return w;
}

function markClass(m: string): string {
  return { "!!": "brilliant", "!": "good", "!?": "interesting", "?!": "dubious", "?": "mistake", "??": "blunder" }[m] ?? "";
}

const COMMENT_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 3v-3h-.5A1.5 1.5 0 0 1 2 9.5z" fill="currentColor"/></svg>';

/** The extra pieces, as icons in the colour of the side that has them ("+3" after more than four). */
export function materialView(fx: Features): HTMLElement | null {
  const { white, black } = fx.extra;
  if (!white.length && !black.length) return null;
  const box = document.createElement("span");
  box.className = "gc-material";
  const words = (side: string, ps: PieceType[]) => `${side}: ${ps.join(" ")}`;
  box.title = [white.length ? words("White has more", white) : "", black.length ? words("Black has more", black) : ""]
    .filter(Boolean)
    .join("\n");
  const add = (ps: PieceType[], w: boolean) => {
    for (const p of ps.slice(0, 4)) {
      const i = document.createElement("span");
      i.className = "gc-piece";
      i.style.backgroundImage = `url("${pieceUrl((w ? p : p.toLowerCase()) as never)}")`;
      box.append(i);
    }
    if (ps.length > 4) box.append(`+${ps.length - 4}`);
  };
  add(white, true);
  if (white.length && black.length) box.append(" vs ");
  add(black, false);
  if (fx.material) {
    const v = document.createElement("span");
    v.className = "gc-material-sum";
    v.textContent = (fx.material > 0 ? "+" : "−") + Math.abs(fx.material);
    box.append(v);
  }
  return box;
}
