// The chessboard view: squares, pieces (sliding when they move), highlights, arrows,
// dragging and the promotion picker. It knows nothing about rules; a BoardInput decides
// what clicks and drops mean (see move-input.ts).
import { isWhite, type PieceCode, type Placement } from "../chess/fen.ts";
import "./board.css";

const PIECE_URLS = import.meta.glob("../assets/pieces/*.svg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

export function pieceUrl(piece: PieceCode): string {
  const name = (isWhite(piece) ? "w" : "b") + piece.toUpperCase();
  return PIECE_URLS[`../assets/pieces/${name}.svg`];
}

export type Color = "white" | "black";

export interface BoardInput {
  /** Pointer pressed on a square. Return true if the piece there may be dragged. */
  pointerDown(sq: number): boolean;
  /** Pointer released on the square where it was pressed (a click). */
  release(sq: number): void;
  /** A dragged piece was dropped on another square (null: off the board). */
  drop(from: number, to: number | null): void;
}

export interface Highlights {
  lastMove?: [number, number];
  selected?: number;
  check?: number;
  /** Squares the selected piece can move to. */
  targets?: number[];
  premove?: [number, number];
}

export interface Arrow {
  from: number;
  to: number;
}

const DRAG_THRESHOLD = 4; // px before a press becomes a drag

export class Board {
  readonly el: HTMLElement;
  private input: BoardInput | null = null;
  private orientation: Color = "white";
  private placement: Placement = new Array(64).fill(null);
  private pieces = new Map<number, HTMLElement>();
  private highlightLayer: HTMLElement;
  private pieceLayer: HTMLElement;
  private arrowLayer: SVGSVGElement;
  private coordLayer: HTMLElement;
  private overlay: HTMLElement | null = null;
  private highlights: Highlights = {};
  private arrows: Arrow[] = [];
  private drag: { from: number; x: number; y: number; moving: boolean; pointer: number } | null = null;
  private inDrop = false;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "board";
    this.coordLayer = this.layer("board-coords");
    this.highlightLayer = this.layer("board-highlights");
    this.pieceLayer = this.layer("board-pieces");
    this.arrowLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.arrowLayer.setAttribute("class", "board-arrows");
    this.arrowLayer.setAttribute("viewBox", "0 0 8 8");
    this.el.append(this.arrowLayer);
    this.renderCoords();

    this.el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.el.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.el.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.el.addEventListener("pointercancel", () => this.cancelDrag());
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private layer(cls: string): HTMLElement {
    const el = document.createElement("div");
    el.className = cls;
    this.el.append(el);
    return el;
  }

  setInput(input: BoardInput): void {
    this.input = input;
  }

  setOrientation(color: Color): void {
    if (color === this.orientation) return;
    this.orientation = color;
    this.renderCoords();
    for (const [sq, el] of this.pieces) this.place(el, sq);
    this.renderHighlights();
    this.renderArrows();
  }

  getOrientation(): Color {
    return this.orientation;
  }

  /** Shows a position. Pieces that moved slide to their new squares unless animate is false. */
  setPlacement(placement: Placement, animate = true): void {
    if (this.inDrop) animate = false; // the dropped piece is already where it belongs
    const old = new Map(this.pieces);
    const next = new Map<number, HTMLElement>();
    const unplaced: number[] = [];
    // Pieces that stay where they are.
    for (let sq = 0; sq < 64; sq++) {
      const piece = placement[sq];
      if (!piece) continue;
      const el = old.get(sq);
      if (el && this.placement[sq] === piece) {
        next.set(sq, el);
        old.delete(sq);
      } else unplaced.push(sq);
    }
    // Moved pieces: the nearest old piece of the same kind that is no longer on its square.
    for (const sq of unplaced) {
      const piece = placement[sq]!;
      let best: number | null = null;
      for (const [from] of old) {
        if (this.placement[from] !== piece) continue;
        if (best === null || distance(from, sq) < distance(best, sq)) best = from;
      }
      let el: HTMLElement;
      if (best !== null) {
        el = old.get(best)!;
        old.delete(best);
        el.classList.toggle("instant", !animate);
      } else {
        el = document.createElement("div");
        el.className = "piece instant";
        el.style.backgroundImage = `url("${pieceUrl(piece)}")`;
        this.pieceLayer.append(el);
      }
      this.place(el, sq);
      next.set(sq, el);
    }
    for (const el of old.values()) el.remove(); // captured
    this.pieces = next;
    this.placement = placement.slice();
    // Re-enable sliding for the next update once this one is laid out.
    requestAnimationFrame(() => {
      for (const el of this.pieces.values()) el.classList.remove("instant");
    });
  }

  setHighlights(h: Highlights): void {
    this.highlights = h;
    this.renderHighlights();
  }

  setArrows(arrows: Arrow[]): void {
    this.arrows = arrows;
    this.renderArrows();
  }

  /** Lets the player pick the promotion piece. Resolves to "q", "r", "b", "n" or null (cancelled). */
  choosePromotion(sq: number, white: boolean): Promise<"q" | "r" | "b" | "n" | null> {
    this.closeOverlay();
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "board-overlay";
      const { col, row } = this.view(sq);
      const down = row === 0; // list runs from the promotion square towards the board's centre
      (["q", "n", "r", "b"] as const).forEach((p, i) => {
        const btn = document.createElement("button");
        btn.className = "promotion-choice";
        btn.setAttribute("aria-label", { q: "Queen", n: "Knight", r: "Rook", b: "Bishop" }[p]);
        btn.style.backgroundImage = `url("${pieceUrl((white ? p.toUpperCase() : p) as PieceCode)}")`;
        btn.style.transform = `translate(${col * 100}%, ${(down ? row + i : row - i) * 100}%)`;
        btn.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          this.closeOverlay();
          resolve(p);
        });
        overlay.append(btn);
      });
      overlay.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.closeOverlay();
        resolve(null);
      });
      this.overlay = overlay;
      this.el.append(overlay);
    });
  }

  private closeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  // --- geometry -------------------------------------------------------------------------

  /** Column and row on screen (0,0 = top left) of a square. */
  private view(sq: number): { col: number; row: number } {
    const file = sq & 7,
      rank = sq >> 3;
    return this.orientation === "white" ? { col: file, row: 7 - rank } : { col: 7 - file, row: rank };
  }

  private squareAt(clientX: number, clientY: number): number | null {
    const r = this.el.getBoundingClientRect();
    const col = Math.floor(((clientX - r.left) / r.width) * 8);
    const row = Math.floor(((clientY - r.top) / r.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return this.orientation === "white" ? (7 - row) * 8 + col : row * 8 + (7 - col);
  }

  private place(el: HTMLElement, sq: number): void {
    const { col, row } = this.view(sq);
    el.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
  }

  // --- rendering ------------------------------------------------------------------------

  private renderCoords(): void {
    this.coordLayer.replaceChildren();
    for (let i = 0; i < 8; i++) {
      // Files along the bottom row, ranks along the left column.
      // The bottom left square is dark and the top left one light in both orientations.
      const file = document.createElement("span");
      file.className = "coord coord-file " + (i % 2 === 0 ? "on-dark" : "on-light");
      file.textContent = "abcdefgh"[this.orientation === "white" ? i : 7 - i];
      file.style.left = `${(i + 1) * 12.5}%`;
      const rank = document.createElement("span");
      rank.className = "coord coord-rank " + (i % 2 === 0 ? "on-light" : "on-dark");
      rank.textContent = String(this.orientation === "white" ? 8 - i : i + 1);
      rank.style.top = `${i * 12.5}%`;
      this.coordLayer.append(file, rank);
    }
  }

  private renderHighlights(): void {
    const h = this.highlights;
    const layer = this.highlightLayer;
    layer.replaceChildren();
    const mark = (sq: number, cls: string) => {
      const el = document.createElement("div");
      el.className = "mark " + cls;
      this.place(el, sq);
      layer.append(el);
    };
    if (h.lastMove) h.lastMove.forEach((sq) => mark(sq, "last-move"));
    if (h.premove) h.premove.forEach((sq) => mark(sq, "premove"));
    if (h.selected !== undefined) mark(h.selected, "selected");
    if (h.check !== undefined) mark(h.check, "check");
    for (const sq of h.targets ?? []) mark(sq, this.placement[sq] ? "target-capture" : "target");
  }

  private renderArrows(): void {
    const svg = this.arrowLayer;
    svg.replaceChildren();
    if (!this.arrows.length) return;
    const ns = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(ns, "defs");
    defs.innerHTML =
      '<marker id="arrowhead" markerWidth="4" markerHeight="4" refX="2.05" refY="2" orient="auto">' +
      '<path d="M0,0 V4 L3,2 Z" fill="var(--arrow)"/></marker>';
    svg.append(defs);
    for (const a of this.arrows) {
      const f = this.view(a.from),
        t = this.view(a.to);
      const x1 = f.col + 0.5,
        y1 = f.row + 0.5;
      let x2 = t.col + 0.5,
        y2 = t.row + 0.5;
      const len = Math.hypot(x2 - x1, y2 - y1);
      x2 -= ((x2 - x1) / len) * 0.4; // leave room for the head
      y2 -= ((y2 - y1) / len) * 0.4;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.setAttribute("class", "arrow");
      line.setAttribute("marker-end", "url(#arrowhead)");
      svg.append(line);
    }
  }

  // --- pointer input --------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.input) return;
    const sq = this.squareAt(e.clientX, e.clientY);
    if (sq === null) return;
    e.preventDefault();
    const draggable = this.input.pointerDown(sq);
    if (draggable && this.pieces.has(sq)) {
      this.drag = { from: sq, x: e.clientX, y: e.clientY, moving: false, pointer: e.pointerId };
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        // pointer already gone (or synthetic): dragging still works while over the board
      }
    } else {
      this.drag = null;
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    const el = this.pieces.get(d.from);
    if (!el) return;
    if (!d.moving && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return;
    d.moving = true;
    el.classList.add("dragging");
    const r = this.el.getBoundingClientRect();
    const size = r.width / 8;
    el.style.transform = `translate(${e.clientX - r.left - size / 2}px, ${e.clientY - r.top - size / 2}px)`;
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!this.input) return;
    const sq = this.squareAt(e.clientX, e.clientY);
    if (!d || !d.moving) {
      if (sq !== null) this.input.release(sq);
      return;
    }
    const el = this.pieces.get(d.from);
    el?.classList.remove("dragging");
    if (sq === d.from) {
      el?.classList.add("instant");
      if (el) this.place(el, d.from);
      this.input.release(sq);
      return;
    }
    this.inDrop = true;
    try {
      this.input.drop(d.from, sq);
    } finally {
      this.inDrop = false;
    }
    // Not moved (illegal, or a promotion still being chosen): slide back.
    if (this.pieces.get(d.from) === el && el) this.place(el, d.from);
  }

  private cancelDrag(): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const el = this.pieces.get(d.from);
    if (el) {
      el.classList.remove("dragging");
      this.place(el, d.from);
    }
  }
}

function distance(a: number, b: number): number {
  return Math.abs((a & 7) - (b & 7)) + Math.abs((a >> 3) - (b >> 3));
}
