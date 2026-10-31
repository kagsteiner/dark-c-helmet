// A position being edited on the Setup screen: pieces, side to move, castling rights,
// en passant square. Converts to and from FEN and finds what is wrong with it.
import { placementFromFen, type PieceCode, type Placement } from "./fen.ts";

export type Side = "w" | "b";
export type CastleKey = "K" | "Q" | "k" | "q"; // white/black, kingside/queenside

export interface EditPosition {
  placement: Placement;
  turn: Side;
  castling: Record<CastleKey, boolean>;
  /** En passant target square (a3-h3 / a6-h6), or null. */
  ep: number | null;
}

const FILES = "abcdefgh";

export function emptyPosition(): EditPosition {
  return { placement: new Array(64).fill(null), turn: "w", castling: { K: false, Q: false, k: false, q: false }, ep: null };
}

/** The rook a castling right would use: the outermost own rook on the first rank on that side
 *  of the king, or null (no king on the first rank, or no rook there). */
export function castlingRook(p: Placement, key: CastleKey): number | null {
  const white = key === key.toUpperCase();
  const rank = white ? 0 : 7;
  const king = p.findIndex((pc, sq) => pc === (white ? "K" : "k") && sq >> 3 === rank);
  if (king < 0) return null;
  const rook = white ? "R" : "r";
  const kingside = key.toUpperCase() === "K";
  const files = kingside ? [7, 6, 5, 4, 3, 2, 1] : [0, 1, 2, 3, 4, 5, 6];
  for (const f of files) {
    const sq = rank * 8 + f;
    if (kingside ? f <= (king & 7) : f >= (king & 7)) break;
    if (p[sq] === rook) return sq;
  }
  return null;
}

/** Squares where an en passant capture is possible: an enemy pawn that may just have made a
 *  double step and stands next to a pawn of the side to move. */
export function epCandidates(pos: EditPosition): number[] {
  const p = pos.placement;
  const white = pos.turn === "w";
  const theirPawn: PieceCode = white ? "p" : "P";
  const ourPawn: PieceCode = white ? "P" : "p";
  const rank = white ? 4 : 3; // the double-stepped pawn stands on rank 5 (white to move) or 4
  const out: number[] = [];
  for (let f = 0; f < 8; f++) {
    const sq = rank * 8 + f;
    const behind = sq + (white ? 8 : -8); // the square passed over = e.p. target
    const start = sq + (white ? 16 : -16);
    if (p[sq] !== theirPawn || p[behind] || p[start]) continue;
    if ((f > 0 && p[sq - 1] === ourPawn) || (f < 7 && p[sq + 1] === ourPawn)) out.push(behind);
  }
  return out;
}

/** FEN of the position. Castling is written KQkq when the rooks are in the corners and the
 *  kings on the e-file, otherwise with rook files (Shredder-FEN, needed for Chess960). */
export function toFen(pos: EditPosition): string {
  const p = pos.placement;
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = "",
      empty = 0;
    for (let f = 0; f < 8; f++) {
      const pc = p[r * 8 + f];
      if (!pc) empty++;
      else {
        if (empty) row += empty;
        empty = 0;
        row += pc;
      }
    }
    rows.push(row + (empty ? empty : ""));
  }
  let castling = "";
  for (const key of ["K", "Q", "k", "q"] as CastleKey[]) {
    if (!pos.castling[key]) continue;
    const rook = castlingRook(p, key);
    if (rook === null) continue;
    const white = key === "K" || key === "Q";
    const king = p.indexOf(white ? "K" : "k");
    const standard = (king & 7) === 4 && (rook & 7) === (key.toUpperCase() === "K" ? 7 : 0);
    const letter = standard ? key : FILES[rook & 7];
    castling += white ? letter.toUpperCase() : letter;
  }
  const ep = pos.ep !== null && epCandidates(pos).includes(pos.ep) ? FILES[pos.ep & 7] + ((pos.ep >> 3) + 1) : "-";
  return `${rows.join("/")} ${pos.turn} ${castling || "-"} ${ep} 0 1`;
}

/** Reads a FEN (standard, X-FEN or Shredder-FEN castling). Returns null if it is malformed. */
export function fromFen(fen: string): EditPosition | null {
  const parts = fen.trim().split(/\s+/);
  const rows = parts[0]?.split("/");
  if (!rows || rows.length !== 8) return null;
  for (const row of rows) {
    let n = 0;
    for (const ch of row) {
      if (/[1-8]/.test(ch)) n += Number(ch);
      else if (/[KQRBNPkqrbnp]/.test(ch)) n++;
      else return null;
    }
    if (n !== 8) return null;
  }
  const placement = placementFromFen(parts[0]);
  const turn = parts[1] === "b" ? "b" : "w";
  const castling = { K: false, Q: false, k: false, q: false };
  for (const ch of parts[2] ?? "-") {
    if (ch === "-") continue;
    const white = ch === ch.toUpperCase();
    const king = placement.indexOf(white ? "K" : "k");
    let side: "K" | "Q";
    if (/[KQkq]/.test(ch)) side = ch.toUpperCase() as "K" | "Q";
    else if (/[A-Ha-h]/.test(ch)) side = FILES.indexOf(ch.toLowerCase()) > (king & 7) ? "K" : "Q";
    else continue;
    castling[(white ? side : side.toLowerCase()) as CastleKey] = true;
  }
  const epText = parts[3] ?? "-";
  const ep = /^[a-h][36]$/.test(epText) ? (Number(epText[1]) - 1) * 8 + FILES.indexOf(epText[0]) : null;
  return { placement, turn, castling, ep };
}

/** Castling rights that cannot apply to the pieces as they stand are dropped. */
export function normalizeCastling(pos: EditPosition): void {
  for (const key of ["K", "Q", "k", "q"] as CastleKey[]) {
    if (pos.castling[key] && castlingRook(pos.placement, key) === null) pos.castling[key] = false;
  }
  if (pos.ep !== null && !epCandidates(pos).includes(pos.ep)) pos.ep = null;
}

/** Problems that make the position unplayable (the check test needs the rules module). */
export function problems(pos: EditPosition, opponentInCheck: () => boolean): string[] {
  const p = pos.placement;
  const out: string[] = [];
  const count = (pc: PieceCode) => p.filter((x) => x === pc).length;
  if (count("K") !== 1) out.push("White needs exactly one king.");
  if (count("k") !== 1) out.push("Black needs exactly one king.");
  if ([...p.slice(0, 8), ...p.slice(56)].some((x) => x === "P" || x === "p")) out.push("Pawns cannot stand on the first or last rank.");
  if (count("P") > 8 || count("p") > 8) out.push("A side cannot have more than 8 pawns.");
  if (p.filter((x) => x && x === x.toUpperCase()).length > 16 || p.filter((x) => x && x === x.toLowerCase()).length > 16)
    out.push("A side cannot have more than 16 pieces.");
  if (!out.length && opponentInCheck()) out.push(`${pos.turn === "w" ? "Black" : "White"} is in check but it is not their move.`);
  return out;
}

/** Does the position need Chess960 castling rules (a castling king or rook off its standard square)? */
export function needsChess960(pos: EditPosition): boolean {
  return toFen(pos).split(" ")[2].replace(/[KQkq-]/g, "") !== "";
}
