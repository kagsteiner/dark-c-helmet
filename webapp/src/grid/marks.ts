// The analysis marks drawn on a board (small or large; `flipped`: Black at the bottom): a red glow
// around a king in danger (under the pieces), a red dot on weak pawns, a green arrow on
// passed pawns and a red ring around pieces lost in the exchange (above the pieces).
// Red: weakness or danger; green: strength.
import type { Features } from "./features.ts";

/** Danger level from which a king glows. */
export const GLOW_FROM = 3;

/** Where square `sq` is drawn: left and top in percent of the board. */
export function squarePos(sq: number, flipped: boolean): { left: number; top: number } {
  const file = sq & 7;
  const rank = sq >> 3;
  return flipped ? { left: (7 - file) * 12.5, top: rank * 12.5 } : { left: file * 12.5, top: (7 - rank) * 12.5 };
}

function at(cls: string, sq: number, flipped: boolean): HTMLElement {
  const d = document.createElement("div");
  d.className = cls;
  const { left, top } = squarePos(sq, flipped);
  d.style.left = left + "%";
  d.style.top = top + "%";
  return d;
}

/** Marks that go under the pieces. */
export function underMarks(fx: Features, flipped: boolean): HTMLElement[] {
  return fx.kings
    .filter((k) => k.danger >= GLOW_FROM)
    .map((k) => {
      const d = at("fm-glow", k.sq, flipped);
      d.style.opacity = String(Math.min(0.9, 0.3 + (k.danger - GLOW_FROM) * 0.15));
      d.title = `${k.white ? "White" : "Black"} king in danger`;
      return d;
    });
}

/** Marks that go above the pieces. */
export function overMarks(fx: Features, hanging: number[], flipped: boolean): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const sq of hanging) {
    const d = at("fm-hanging", sq, flipped);
    d.title = "Lost in the exchange: the opponent wins material by capturing it";
    out.push(d);
  }
  for (const sq of fx.weak) out.push(at("fm-weak", sq, flipped));
  // The arrow points where the pawn runs, as seen on the screen.
  for (const p of fx.passed) {
    out.push(at(`fm-passed ${p.white !== flipped ? "up" : "down"}${p.advanced ? " advanced" : ""}`, p.sq, flipped));
  }
  return out;
}
