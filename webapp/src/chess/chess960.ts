// Chess960 starting positions by number (0-959, Scharnagl numbering; 518 is the standard one).

const KNIGHTS = ["NN---", "N-N--", "N--N-", "N---N", "-NN--", "-N-N-", "-N--N", "--NN-", "--N-N", "---NN"];

export function chess960Fen(n: number): string {
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
  const files = "abcdefgh";
  // Castling rights as rook files (Shredder-FEN), e.g. "HAha" for the standard position.
  const rights = files[r2].toUpperCase() + files[r1].toUpperCase() + files[r2] + files[r1];
  const white = rank.join("");
  return `${white.toLowerCase()}/pppppppp/8/8/8/8/PPPPPPPP/${white} w ${rights} - 0 1`;
}

export function randomChess960(): number {
  return Math.floor(Math.random() * 960);
}
