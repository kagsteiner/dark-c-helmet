// Chess960 starting positions by number (0-959, Scharnagl numbering; 518 is the standard one),
// and Chess 960²: White and Black each get their own back rank (960 × 960 starts).

const KNIGHTS = ["NN---", "N-N--", "N--N-", "N---N", "-NN--", "-N-N-", "-N--N", "--NN-", "--N-N", "---NN"];
const FILES = "abcdefgh";

/** White's back rank of start position n, from a1 to h1 (e.g. "RNBQKBNR" for 518). */
export function backRank(n: number): string {
  const rank: string[] = new Array(8).fill("");
  rank[[1, 3, 5, 7][n % 4]] = "B";
  n = Math.floor(n / 4);
  rank[[0, 2, 4, 6][n % 4]] = "B";
  n = Math.floor(n / 4);
  const empty = () => rank.flatMap((p, i) => (p ? [] : [i]));
  rank[empty()[n % 6]] = "Q";
  n = Math.floor(n / 6);
  const free = empty();
  [...KNIGHTS[n]].forEach((c, i) => {
    if (c === "N") rank[free[i]] = "N";
  });
  const [r1, k, r2] = empty();
  rank[r1] = "R";
  rank[k] = "K";
  rank[r2] = "R";
  return rank.join("");
}

/** Castling rights of one back rank as rook files (Shredder-FEN): kingside rook, then queenside. */
function rookFiles(rank: string): string {
  return FILES[rank.lastIndexOf("R")] + FILES[rank.indexOf("R")];
}

export function chess960Fen(n: number): string {
  return chess960SquaredFen(n, n);
}

/** Chess 960²: White starts from position `white`, Black from position `black` (its pieces on the
 *  same files as White's would be in position `black`). Equal numbers give plain Chess960. */
export function chess960SquaredFen(white: number, black: number): string {
  const w = backRank(white), b = backRank(black);
  const rights = rookFiles(w).toUpperCase() + rookFiles(b);
  return `${b.toLowerCase()}/pppppppp/8/8/8/8/PPPPPPPP/${w} w ${rights} - 0 1`;
}

export function randomChess960(): number {
  return Math.floor(Math.random() * 960);
}
