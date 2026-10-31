// Squares a piece might be able to move to once the opponent has moved (premove targets):
// its movement pattern on an empty board, plus castling squares for a king on its first rank.
// Whether the premove is legal is decided when it is played.
import { isWhite, type Placement } from "../chess/fen.ts";

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function premoveTargets(placement: Placement, sq: number): number[] {
  const piece = placement[sq];
  if (!piece) return [];
  const white = isWhite(piece);
  const f = sq & 7,
    r = sq >> 3;
  const out: number[] = [];
  const add = (df: number, dr: number) => {
    const nf = f + df,
      nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) out.push(nr * 8 + nf);
  };
  const rays = (dirs: number[][]) => {
    for (const [df, dr] of dirs) for (let i = 1; i < 8; i++) add(df * i, dr * i);
  };
  switch (piece.toUpperCase()) {
    case "P": {
      const dir = white ? 1 : -1;
      add(0, dir);
      if (r === (white ? 1 : 6)) add(0, 2 * dir);
      add(-1, dir);
      add(1, dir);
      break;
    }
    case "N":
      KNIGHT.forEach(([df, dr]) => add(df, dr));
      break;
    case "B":
      rays(DIAG);
      break;
    case "R":
      rays(ORTHO);
      break;
    case "Q":
      rays(DIAG);
      rays(ORTHO);
      break;
    case "K": {
      KING.forEach(([df, dr]) => add(df, dr));
      if (r === (white ? 0 : 7)) {
        // Castling: the king's target squares and the own rooks on the first rank.
        add(2 - f, 0);
        add(6 - f, 0);
        for (let file = 0; file < 8; file++) if (placement[r * 8 + file] === (white ? "R" : "r")) out.push(r * 8 + file);
      }
      break;
    }
  }
  return [...new Set(out)].filter((t) => t !== sq);
}
