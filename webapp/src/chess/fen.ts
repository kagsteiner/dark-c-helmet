// Reading the piece placement of a FEN for display.

/** Piece codes as in FEN: "K" white king, "q" black queen, ... */
export type PieceCode = "K" | "Q" | "R" | "B" | "N" | "P" | "k" | "q" | "r" | "b" | "n" | "p";

/** 64 entries, a1 = 0, h8 = 63; null for an empty square. */
export type Placement = (PieceCode | null)[];

export function placementFromFen(fen: string): Placement {
  const board: Placement = new Array(64).fill(null);
  const rows = fen.split(" ")[0].split("/");
  rows.forEach((row, i) => {
    let file = 0;
    for (const ch of row) {
      if (ch >= "1" && ch <= "8") file += Number(ch);
      else board[(7 - i) * 8 + file++] = ch as PieceCode;
    }
  });
  return board;
}

export function isWhite(piece: PieceCode): boolean {
  return piece === piece.toUpperCase();
}
