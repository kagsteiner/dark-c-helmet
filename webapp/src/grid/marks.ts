// The analysis marks drawn on a board (small or large, White at the bottom): a red glow
// around a king in danger (under the pieces), a red dot on weak pawns, a green arrow on
// passed pawns and a red ring around pieces lost in the exchange (above the pieces).
// Red: weakness or danger; green: strength.
import type { Features } from "./features.ts";

/** Danger level from which a king glows. */
export const GLOW_FROM = 3;

function at(cls: string, sq: number): HTMLElement {
  const d = document.createElement("div");
  d.className = cls;
  d.style.left = (sq & 7) * 12.5 + "%";
  d.style.top = (7 - (sq >> 3)) * 12.5 + "%";
  return d;
}

/** Marks that go under the pieces. */
export function underMarks(fx: Features): HTMLElement[] {
  return fx.kings
    .filter((k) => k.danger >= GLOW_FROM)
    .map((k) => {
      const d = at("fm-glow", k.sq);
      d.style.opacity = String(Math.min(0.9, 0.3 + (k.danger - GLOW_FROM) * 0.15));
      d.title = `${k.white ? "White" : "Black"} king in danger`;
      return d;
    });
}

/** Marks that go above the pieces. */
export function overMarks(fx: Features, hanging: number[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const sq of hanging) {
    const d = at("fm-hanging", sq);
    d.title = "Lost in the exchange: the opponent wins material by capturing it";
    out.push(d);
  }
  for (const sq of fx.weak) out.push(at("fm-weak", sq));
  for (const p of fx.passed) out.push(at(`fm-passed ${p.white ? "up" : "down"}${p.advanced ? " advanced" : ""}`, p.sq));
  return out;
}
