// Evaluation over the game: White's winning chances per position (top = White winning).
// One series, so no legend; hover shows the move and score, a click jumps to the position.
// Behind the curve, faint bands mark the moves played from a narrow position (only one, two
// or three moves held): the band spans the move, so its mark sits at the band's right edge.
import { MARK_SYMBOL, winPercent, type Mark } from "../analysis/review.ts";

export interface GraphData {
  /** White's centipawns after i moves (null: not evaluated). */
  evals: (number | null)[];
  /** marks[i] belongs to the move leading to position i + 1. */
  marks: (Mark | null)[];
  /** labels[i]: the move leading to position i + 1, e.g. "12… Qxe4". */
  labels: string[];
  cursor: number;
  /** narrow[i]: moves that held in position i (1-3), 0 when not narrow or not measured. */
  narrow?: number[];
}

/** Hover text for a move played from a position where `n` moves held. */
export function narrowLabel(n: number): string {
  return n === 1 ? "only move" : n > 1 && n <= 3 ? `${n} moves held` : "";
}

const HEIGHT = 96;
const GUTTER = 24; // room for the pawn scale on the left
const SCALE = [5, 2, 0, -2, -5]; // pawns, White's view; the axis is winning chances, so the steps narrow

export class EvalGraph {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private tip: HTMLElement;
  private data: GraphData = { evals: [], marks: [], labels: [], cursor: 0 };
  private onSelect: (ply: number) => void;

  constructor(onSelect: (ply: number) => void) {
    this.onSelect = onSelect;
    this.el = document.createElement("div");
    this.el.className = "eval-graph";
    this.el.innerHTML = `<svg role="img" aria-label="Evaluation graph"></svg><div class="eval-tip small" hidden></div>`;
    this.svg = this.el.querySelector("svg")!;
    this.tip = this.el.querySelector(".eval-tip")!;
    this.el.addEventListener("pointermove", (e) => this.hover(e));
    this.el.addEventListener("pointerleave", () => this.hover(null));
    this.el.addEventListener("click", (e) => {
      const ply = this.plyAt(e.clientX);
      if (ply !== null) this.onSelect(ply);
    });
    new ResizeObserver(() => this.render()).observe(this.el);
  }

  set(data: GraphData): void {
    this.data = data;
    this.render();
  }

  private width(): number {
    return this.el.clientWidth || 300;
  }

  private x(i: number): number {
    const n = Math.max(1, this.data.evals.length - 1);
    return GUTTER + (i / n) * (this.width() - GUTTER - 4);
  }

  private y(cp: number): number {
    return 4 + (1 - winPercent(cp) / 100) * (HEIGHT - 8);
  }

  private plyAt(clientX: number): number | null {
    const n = this.data.evals.length - 1;
    if (n < 1) return null;
    const r = this.el.getBoundingClientRect();
    const i = Math.round(((clientX - r.left - GUTTER) / (r.width - GUTTER - 4)) * n);
    return Math.max(0, Math.min(n, i));
  }

  private render(): void {
    const { evals, marks, cursor, narrow = [] } = this.data;
    const w = this.width();
    this.svg.setAttribute("viewBox", `0 0 ${w} ${HEIGHT}`);
    this.svg.setAttribute("height", String(HEIGHT));
    const mid = this.y(0);
    const pts = evals.map((e, i) => (e === null ? null : [this.x(i), this.y(e)] as const));
    let line = "",
      area = "";
    let open = false;
    pts.forEach((p, i) => {
      if (!p) {
        if (open) area += `L${pts[i - 1]![0]},${mid}Z`;
        open = false;
        return;
      }
      line += `${open ? "L" : "M"}${p[0]},${p[1]}`;
      area += open ? `L${p[0]},${p[1]}` : `M${p[0]},${mid}L${p[0]},${p[1]}`;
      open = true;
    });
    const lastPt = [...pts].reverse().find((p) => p);
    if (open && lastPt) area += `L${lastPt[0]},${mid}Z`;
    const dots = marks
      .map((m, i) => {
        const p = pts[i + 1];
        return m && p ? `<circle class="dot ${m}" cx="${p[0]}" cy="${p[1]}" r="4"/>` : "";
      })
      .join("");
    const scale = SCALE.map((p) => {
      const y = this.y(p * 100);
      return `<line class="tick" x1="${GUTTER}" x2="${w}" y1="${y}" y2="${y}"/>` +
        `<text class="tick-label" x="${GUTTER - 4}" y="${y}">${p > 0 ? "+" : ""}${p}</text>`;
    }).join("");
    const bands = narrow
      .map((n, i) => {
        if (n < 1 || n > 3 || i >= evals.length - 1) return "";
        const x0 = this.x(i);
        return `<rect class="band n${n}" x="${x0}" y="0" width="${Math.max(1, this.x(i + 1) - x0)}" height="${HEIGHT}"/>`;
      })
      .join("");
    this.svg.innerHTML = `
      ${bands}
      ${scale}
      <line class="mid" x1="${GUTTER}" x2="${w}" y1="${mid}" y2="${mid}"/>
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
      <line class="cursor" x1="${this.x(cursor)}" x2="${this.x(cursor)}" y1="0" y2="${HEIGHT}"/>
      <line class="crosshair" x1="0" x2="0" y1="0" y2="${HEIGHT}" visibility="hidden"/>
      ${dots}`;
  }

  private hover(e: PointerEvent | null): void {
    const cross = this.svg.querySelector<SVGLineElement>(".crosshair");
    const ply = e ? this.plyAt(e.clientX) : null;
    if (ply === null || !cross) {
      this.tip.hidden = true;
      cross?.setAttribute("visibility", "hidden");
      return;
    }
    const x = this.x(ply);
    cross.setAttribute("x1", String(x));
    cross.setAttribute("x2", String(x));
    cross.setAttribute("visibility", "visible");
    const ev = this.data.evals[ply];
    const label = ply === 0 ? "Start" : this.data.labels[ply - 1] + (this.data.marks[ply - 1] ? MARK_SYMBOL[this.data.marks[ply - 1]!] : "");
    const score = ev === null ? "–" : Math.abs(ev) >= 9000 ? (ev > 0 ? "#" : "-#") + (10000 - Math.abs(ev)) : (ev > 0 ? "+" : "") + (ev / 100).toFixed(2);
    const narrow = ply > 0 ? narrowLabel(this.data.narrow?.[ply - 1] ?? 0) : "";
    this.tip.textContent = `${label} · ${score}` + (narrow ? ` · ${narrow}` : "");
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${Math.min(Math.max(0, x - tw / 2), this.width() - tw)}px`;
  }
}
