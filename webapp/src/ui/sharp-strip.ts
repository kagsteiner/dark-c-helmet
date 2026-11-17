// Sharpness along a game: one cell per position, in two lanes (top: White to move, bottom:
// Black to move), darker for a narrower path. A click jumps to the position.
import { BAND_LABEL, BAND_LEVEL, sharpBand, type Sharpness } from "../book/sharpness.ts";

export interface StripCell {
  /** Who is to move in the position. */
  white: boolean;
  /** Not measured: null. */
  sharpness: Sharpness | null;
  /** For the tooltip, e.g. "after 12. e4". */
  label: string;
}

export class SharpStrip {
  readonly el: HTMLElement;
  private onSelect: (ply: number) => void;

  constructor(onSelect: (ply: number) => void) {
    this.onSelect = onSelect;
    this.el = document.createElement("div");
    this.el.className = "sharp-strip";
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", "Sharpness per position, top row White to move, bottom row Black to move");
    this.el.addEventListener("click", (e) => {
      const ply = (e.target as HTMLElement).closest<HTMLElement>("[data-ply]")?.dataset.ply;
      if (ply !== undefined) this.onSelect(Number(ply));
    });
  }

  set(cells: StripCell[], cursor: number): void {
    this.el.style.gridTemplateColumns = `repeat(${Math.max(1, cells.length)}, minmax(0, 1fr))`;
    this.el.replaceChildren(
      ...cells.map((c, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.ply = String(i);
        const band = c.sharpness ? sharpBand(c.sharpness) : null;
        b.className = "sharp-cell " + (band ? `lvl-${BAND_LEVEL[band]}` : "unknown") + (i === cursor ? " current" : "");
        b.style.gridColumn = String(i + 1);
        b.style.gridRow = c.white ? "1" : "2";
        b.title = `${c.label}, ${c.white ? "White" : "Black"} to move: ${band ? BAND_LABEL[band] : "not measured"}`;
        b.tabIndex = -1; // the moves list and arrow keys already navigate
        return b;
      }),
    );
  }
}
