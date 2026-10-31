// Evaluation over the game: White's winning chances per position (top = White winning).
// One series, so no legend; hover shows the move and score, a click jumps to the position.
import { MARK_SYMBOL, winPercent, type Mark } from "../analysis/review.ts";

export interface GraphData {
  /** White's centipawns after i moves (null: not evaluated). */
  evals: (number | null)[];
  /** marks[i] belongs to the move leading to position i + 1. */
  marks: (Mark | null)[];
  /** labels[i]: the move leading to position i + 1, e.g. "12… Qxe4". */
  labels: string[];
  cursor: number;
}

const HEIGHT = 96;

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
    return 4 + (i / n) * (this.width() - 8);
  }

  private y(cp: number): number {
    return 4 + (1 - winPercent(cp) / 100) * (HEIGHT - 8);
  }

  private plyAt(clientX: number): number | null {
    const n = this.data.evals.length - 1;
    if (n < 1) return null;
    const r = this.el.getBoundingClientRect();
    const i = Math.round(((clientX - r.left - 4) / (r.width - 8)) * n);
    return Math.max(0, Math.min(n, i));
  }

  private render(): void {
    const { evals, marks, cursor } = this.data;
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
    this.svg.innerHTML = `
      <line class="mid" x1="0" x2="${w}" y1="${mid}" y2="${mid}"/>
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
    this.tip.textContent = `${label} · ${score}`;
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${Math.min(Math.max(0, x - tw / 2), this.width() - tw)}px`;
  }
}
