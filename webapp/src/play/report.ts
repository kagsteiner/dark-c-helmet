// The report card of a game against the engine: how long the player held the position, the
// worst moment, and how often their own analysis in the grid foresaw the engine's reply. The
// measurements the challenges of a later ladder will be made of.

/** An evaluation from the player's point of view: centipawns, or mate in N (positive: the
 *  player mates). */
export type Eval = { cp: number } | { mate: number };

/** The engine's evaluation after its move at `ply` (0-based index in the game's moves). */
export interface EvalPoint {
  ply: number;
  e: Eval;
}

/** Whether the player's analysis contained the engine's reply before it was played: as their
 *  main line ("predicted"), among their lines ("considered"), or not ("missed"). Replies to a
 *  position the player did not analyse are not judged. */
export type Foresight = "predicted" | "considered" | "missed";

/** Holding the position means staying above this (centipawns, player's view). */
export const HOLD_CP = -100;

export interface Report {
  /** Moves of the game (full moves, rounded up). */
  moves: number;
  /** The move at which the evaluation first fell below −1.00; null: never (or no evaluation). */
  fellAt: number | null;
  /** The worst evaluation and its move, if any. */
  worst: { e: Eval; move: number } | null;
  /** Engine replies judged, and how many were considered (predicted included) or predicted. */
  judged: number;
  considered: number;
  predicted: number;
  takebacks: { used: number; of: number } | null;
}

/** For comparing: higher is better for the player; a mate beats any centipawn score. */
export function evalValue(e: Eval): number {
  if ("mate" in e) return e.mate > 0 ? 100_000 - e.mate : -100_000 - e.mate;
  return e.cp;
}

/** The full move a ply belongs to (games from the usual start: ply 0 is White's first move). */
export function moveOfPly(ply: number): number {
  return Math.floor(ply / 2) + 1;
}

export function makeReport(
  plies: number,
  evals: EvalPoint[] | undefined,
  foresight: Record<number, Foresight> | undefined,
  takebacks: { used: number; of: number } | null,
): Report {
  const points = [...(evals ?? [])].sort((a, b) => a.ply - b.ply);
  const fell = points.find((p) => evalValue(p.e) < HOLD_CP);
  let worst: Report["worst"] = null;
  for (const p of points) if (!worst || evalValue(p.e) < evalValue(worst.e)) worst = { e: p.e, move: moveOfPly(p.ply) };
  const judged = Object.values(foresight ?? {});
  return {
    moves: Math.ceil(plies / 2),
    fellAt: points.length && fell ? moveOfPly(fell.ply) : null,
    worst,
    judged: judged.length,
    considered: judged.filter((f) => f !== "missed").length,
    predicted: judged.filter((f) => f === "predicted").length,
    takebacks,
  };
}

/** An evaluation in words: "+0.35", "−4.20", "you mate in 3", "mated in 2". */
export function evalText(e: Eval): string {
  if ("mate" in e) return e.mate > 0 ? `you mate in ${e.mate}` : `mated in ${-e.mate}`;
  const v = e.cp / 100;
  return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
}

/** The report card in one line: "above −1.00 until move 18 · worst −2.30 at move 24 · foresaw 6
 *  of 14 engine replies (2 as your main line) · 2 of 3 takebacks". Empty if nothing is known. */
export function reportText(r: Report, hasEvals: boolean): string {
  const parts: string[] = [];
  if (hasEvals) {
    parts.push(r.fellAt === null ? `above −1.00 all ${r.moves} moves` : `above −1.00 until move ${r.fellAt}`);
    if (r.worst && evalValue(r.worst.e) < 0) parts.push(`worst ${evalText(r.worst.e)} at move ${r.worst.move}`);
  }
  if (r.judged) {
    parts.push(
      `foresaw ${r.considered} of ${r.judged} engine repl${r.judged === 1 ? "y" : "ies"}` +
        (r.considered ? ` (${r.predicted} as your main line)` : ""),
    );
  }
  if (r.takebacks) parts.push(`${r.takebacks.used} of ${r.takebacks.of} takeback${r.takebacks.of === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
