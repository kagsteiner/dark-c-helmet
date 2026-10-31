// Standard algebraic notation from the legal-move list of the position before the move.
import type { LegalMove } from "./rules.ts";

const FILES = "abcdefgh";

export function squareName(sq: number): string {
  return FILES[sq & 7] + String((sq >> 3) + 1);
}

export function san(move: LegalMove, legal: LegalMove[]): string {
  const suffix = move.mate ? "#" : move.check ? "+" : "";
  if (move.castle) {
    // Kingside if the rook stands on the king's h-side (also in Chess960).
    return ((move.rook & 7) > (move.from & 7) ? "O-O" : "O-O-O") + suffix;
  }
  const to = squareName(move.to);
  const promo = move.promo ? "=" + move.promo.toUpperCase() : "";
  if (move.piece === "P") {
    const from = move.capture ? FILES[move.from & 7] + "x" : "";
    return from + to + promo + suffix;
  }
  // Disambiguation: other pieces of the same kind that can reach the same square.
  const rivals = legal.filter(
    (m) => m.piece === move.piece && m.to === move.to && m.from !== move.from && !m.castle,
  );
  let from = "";
  if (rivals.length) {
    const sameFile = rivals.some((m) => (m.from & 7) === (move.from & 7));
    const sameRank = rivals.some((m) => m.from >> 3 === move.from >> 3);
    if (!sameFile) from = FILES[move.from & 7];
    else if (!sameRank) from = String((move.from >> 3) + 1);
    else from = squareName(move.from);
  }
  return move.piece + from + (move.capture ? "x" : "") + to + suffix;
}
