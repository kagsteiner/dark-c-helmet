// Sharpness of a position: how narrow is the path for the side to move?
//
// Take the scores of all legal moves (from the mover's side, searched alike) and count the
// moves that are within one pawn of the best. Scores are clamped at +-3 pawns first: beyond
// that a position is "clearly decided" and further differences do not matter (a mate is +3).
//   n = 1: forced (one good move)       n = 2: very sharp
//   n = 3: sharp                        n >= 4: robust (many moves hold the position)
// "gap" is what the first mistake costs: best minus second-best score (clamped, centipawns).
// A position with a single legal move is "no choice" - not sharp, there is nothing to find.
// See DESIGN.md, "Sharpness".
import type { BookEntry } from "./book-logic.ts";

export const SHARP_CLAMP_CP = 300;
export const SHARP_WINDOW_CP = 100;

export interface Sharpness {
  /** Moves within SHARP_WINDOW_CP of the best (including the best). */
  n: number;
  /** Best score minus second-best score, centipawns after clamping (0 with one legal move). */
  gap: number;
  /** Number of legal moves. */
  legal: number;
}

/** A sharpness stored for a position (book key) with the quality it was measured at. */
export interface SharpRecord extends Sharpness {
  key: string;
  /** Nodes per move of the probe searches. */
  nodes: number;
  net: string;
}

export const SHARP_FILE_FORMAT = "dark-c-helmet-sharpness";

export function clampScore(cp: number): number {
  return Math.max(-SHARP_CLAMP_CP, Math.min(SHARP_CLAMP_CP, cp));
}

/** Sharpness from the scores of all legal moves (mover's side, centipawns; mates +-10000). */
export function computeSharpness(scores: number[]): Sharpness | null {
  if (!scores.length) return null;
  const s = scores.map(clampScore).sort((a, b) => b - a);
  return {
    n: s.filter((x) => x >= s[0] - SHARP_WINDOW_CP).length,
    gap: s.length > 1 ? s[0] - s[1] : 0,
    legal: s.length,
  };
}

export type SharpBand = "nochoice" | "forced" | "very-sharp" | "sharp" | "robust";

export function sharpBand(s: Sharpness): SharpBand {
  if (s.legal <= 1) return "nochoice";
  return s.n <= 1 ? "forced" : s.n === 2 ? "very-sharp" : s.n === 3 ? "sharp" : "robust";
}

export const BAND_LABEL: Record<SharpBand, string> = {
  nochoice: "No choice",
  forced: "Forced",
  "very-sharp": "Very sharp",
  sharp: "Sharp",
  robust: "Robust",
};

/** Darkness of a band on the strip (0 = none): narrower paths are darker. */
export const BAND_LEVEL: Record<SharpBand, number> = { nochoice: 0, robust: 1, sharp: 2, "very-sharp": 3, forced: 4 };

/** One sentence for the analysis screen. */
export function describeSharpness(s: Sharpness): string {
  if (s.legal <= 1) return "Only one legal move.";
  const pawns = (cp: number) => (cp / 100).toFixed(1);
  const moves = s.n === 1 ? "One move holds" : `${s.n} moves hold`;
  const behind = s.gap < 10 ? "The second best is practically as good." : `The second best is ${pawns(s.gap)} pawns behind it.`;
  return `${moves} within a pawn of the best. ${behind}`;
}

/** Order for the sharp opening style: lower is a narrower path for the opponent. A position
 *  that is unknown, or has no choice, counts as robust. */
export function narrowness(s: Sharpness | undefined): [number, number] {
  if (!s || s.legal <= 1) return [4, 0];
  return [Math.min(s.n, 4), -s.gap];
}

export function compareNarrowness(a: Sharpness | undefined, b: Sharpness | undefined): number {
  const [an, ag] = narrowness(a);
  const [bn, bg] = narrowness(b);
  return an - bn || ag - bg;
}

/** Keeps the record measured with more nodes (a later, deeper run replaces an older one). */
export function mergeSharpRecords(into: Map<string, SharpRecord>, incoming: Iterable<SharpRecord>): { added: number; updated: number; kept: number } {
  const r = { added: 0, updated: 0, kept: 0 };
  for (const rec of incoming) {
    const old = into.get(rec.key);
    if (old && old.nodes >= rec.nodes) r.kept++;
    else {
      r[old ? "updated" : "added"]++;
      into.set(rec.key, rec);
    }
  }
  return r;
}

export function isSharpRecord(x: unknown): x is SharpRecord {
  const r = x as SharpRecord;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.key === "string" &&
    r.key.split(" ").length === 4 &&
    Number.isInteger(r.n) &&
    r.n >= 1 &&
    Number.isInteger(r.legal) &&
    r.legal >= 1 &&
    r.n <= r.legal &&
    typeof r.gap === "number" &&
    typeof r.nodes === "number"
  );
}

/** Looks up the sharpness of the position an entry's move leads to. */
export type SharpLookup = (entry: BookEntry) => Sharpness | undefined;
