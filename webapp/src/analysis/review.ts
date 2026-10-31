// Full-game review: one evaluation per position, and marks for the moves that lost much.
// Moves are judged by the drop in winning chances (as on lichess), so a lost pawn in a
// won position is not called a blunder.

export type Mark = "inaccuracy" | "mistake" | "blunder";

export const MARK_SYMBOL: Record<Mark, string> = { inaccuracy: "?!", mistake: "?", blunder: "??" };

/** Engine score as White's centipawns; mates become ±10000 (minus distance). */
export function whiteCp(score: { cp: number } | { mate: number }, whiteToMove: boolean): number {
  const sign = whiteToMove ? 1 : -1;
  if ("mate" in score) return sign * (score.mate > 0 ? 10000 - score.mate : -10000 - score.mate);
  return sign * score.cp;
}

/** White's winning chances in percent (0-100) for a centipawn score. */
export function winPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** Mark for a move by `white`, from the evaluations before and after it (White's centipawns). */
export function classify(before: number, after: number, white: boolean): Mark | null {
  const drop = white ? winPercent(before) - winPercent(after) : winPercent(after) - winPercent(before);
  // lichess: 0.1 / 0.2 / 0.3 on its -1..1 scale of winning chances = 5 / 10 / 15 percent
  if (drop >= 15) return "blunder";
  if (drop >= 10) return "mistake";
  if (drop >= 5) return "inaccuracy";
  return null;
}

/** Marks for all moves; evals[i] is the evaluation after i moves. */
export function markMoves(evals: number[], whiteStarts: boolean): (Mark | null)[] {
  const marks: (Mark | null)[] = [];
  for (let i = 1; i < evals.length; i++) {
    const white = (i % 2 === 1) === whiteStarts;
    marks.push(classify(evals[i - 1], evals[i], white));
  }
  return marks;
}
