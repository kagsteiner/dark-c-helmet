// A small position analysis for the marks on each board and the notes in the panel:
// material (the extra pieces each side has), pawn structure (weak and passed pawns, by
// square) and king safety (a danger level per king). Rough heuristics, meant to be read at
// a glance.
import type { Placement } from "../chess/fen.ts";

export type PieceType = "Q" | "R" | "B" | "N" | "P";

export interface PassedPawn {
  sq: number;
  white: boolean;
  /** On the 6th or 7th rank (seen from its side). */
  advanced: boolean;
}

export interface KingDanger {
  sq: number;
  white: boolean;
  /** 0 safe; from GLOW_FROM (marks.ts) the board shows a red glow that grows with it. */
  danger: number;
}

export interface Features {
  /** Material balance in pawns, positive: White is ahead. */
  material: number;
  /** The pieces one side has more of than the other, strongest first. */
  extra: { white: PieceType[]; black: PieceType[] };
  /** Isolated and doubled pawns (both colours). */
  weak: number[];
  passed: PassedPawn[];
  kings: KingDanger[];
  notes: string[];
}

const VALUE: Record<string, number> = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
const NAMES: Record<string, string> = { P: "pawn", N: "knight", B: "bishop", R: "rook", Q: "queen" };
const FILES = "abcdefgh";
const ORDER: PieceType[] = ["Q", "R", "B", "N", "P"];

export function features(board: Placement): Features {
  const f: Features = { material: 0, extra: { white: [], black: [] }, weak: [], passed: [], kings: [], notes: [] };
  material(board, f);
  pawns(board, true, f);
  pawns(board, false, f);
  for (const white of [true, false]) {
    const k = kingDanger(board, white, f.notes);
    if (k) f.kings.push(k);
  }
  return f;
}

function material(board: Placement, f: Features): void {
  const count: Record<string, number> = {};
  for (const p of board) if (p) count[p] = (count[p] ?? 0) + 1;
  const notes: string[] = [];
  for (const k of ORDER) {
    const d = (count[k] ?? 0) - (count[k.toLowerCase()] ?? 0);
    f.material += d * VALUE[k];
    for (let i = 0; i < Math.abs(d); i++) (d > 0 ? f.extra.white : f.extra.black).push(k);
    if (d) notes.push(`${d > 0 ? "White" : "Black"} has ${Math.abs(d)} ${NAMES[k]}${Math.abs(d) > 1 ? "s" : ""} more`);
  }
  if (f.material) notes.unshift(`Material: ${f.material > 0 ? "White" : "Black"} is ${Math.abs(f.material)} ahead`);
  else if (notes.length) notes.unshift("Material equal, but different pieces");
  f.notes.push(...notes);
}

function pawns(board: Placement, white: boolean, f: Features): void {
  const own = white ? "P" : "p";
  const enemy = white ? "p" : "P";
  const side = white ? "White" : "Black";
  const files = Array.from({ length: 8 }, () => [] as number[]); // ranks of own pawns per file
  const enemyFiles = Array.from({ length: 8 }, () => [] as number[]);
  board.forEach((p, sq) => {
    if (p === own) files[sq & 7].push(sq >> 3);
    if (p === enemy) enemyFiles[sq & 7].push(sq >> 3);
  });
  for (let file = 0; file < 8; file++) {
    const ranks = files[file];
    if (!ranks.length) continue;
    const isolated = !files[file - 1]?.length && !files[file + 1]?.length;
    if (ranks.length > 1) f.notes.push(`${side}: ${ranks.length > 2 ? "tripled" : "doubled"} ${FILES[file]}-pawns`);
    if (isolated) f.notes.push(`${side}: isolated ${FILES[file]}-pawn${ranks.length > 1 ? "s" : ""}`);
    for (const r of ranks) {
      const sq = r * 8 + file;
      if (isolated || ranks.length > 1) f.weak.push(sq);
      const ahead = (er: number) => (white ? er > r : er < r);
      // Doubled pawns: only the front one can be passed.
      const behindOwn = ranks.some(ahead);
      const blocked = [file - 1, file, file + 1].some((ef) => enemyFiles[ef]?.some(ahead));
      if (!blocked && !behindOwn) {
        const advanced = white ? r >= 5 : r <= 2;
        f.passed.push({ sq, white, advanced });
        f.notes.push(`${side}: ${advanced ? "far advanced " : ""}passed ${FILES[file]}-pawn`);
      }
    }
  }
}

function kingDanger(board: Placement, white: boolean, notes: string[]): KingDanger | null {
  const k = board.indexOf(white ? "K" : "k");
  if (k < 0) return null;
  // Only matters while the opponent has attacking material: a queen, or rook and more.
  let enemyPieces = 0;
  let enemyQueen = false;
  board.forEach((p) => {
    if (!p || p.toUpperCase() === "P" || p.toUpperCase() === "K") return;
    if ((p === p.toUpperCase()) === white) return;
    enemyPieces += VALUE[p.toUpperCase()];
    if (p.toUpperCase() === "Q") enemyQueen = true;
  });
  if (!enemyQueen && enemyPieces < 13) return { sq: k, white, danger: 0 };
  const side = white ? "White" : "Black";
  const kf = k & 7;
  const kr = k >> 3;
  const rel = white ? kr : 7 - kr; // 0 = own back rank
  let danger = 0;
  if (rel > 1) {
    danger += 3;
    notes.push(`${side} king has left its home ranks`);
  } else {
    let missing = 0;
    for (let f = kf - 1; f <= kf + 1; f++) {
      if (f < 0 || f > 7) continue;
      // A pawn up to three ranks ahead still shelters (e4/d4 in the opening is no open king).
      const shield = [1, 2, 3].some((d) => {
        const r = white ? kr + d : kr - d;
        return r >= 0 && r < 8 && board[r * 8 + f] === (white ? "P" : "p");
      });
      if (!shield) missing++;
    }
    if (missing) notes.push(`${side} king: ${missing} shield pawn${missing > 1 ? "s" : ""} missing`);
    danger += missing;
  }
  let near = 0;
  board.forEach((p, sq) => {
    if (!p || p.toUpperCase() === "P" || p.toUpperCase() === "K") return;
    if ((p === p.toUpperCase()) === white) return;
    if (Math.max(Math.abs((sq & 7) - kf), Math.abs((sq >> 3) - kr)) <= 2) near += p.toUpperCase() === "Q" ? 2 : 1;
  });
  if (near) notes.push(`${side} king: enemy pieces close by`);
  danger += near;
  return { sq: k, white, danger };
}
