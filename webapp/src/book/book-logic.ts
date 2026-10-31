// The opening book's rules, without storage (tested in Node).
//
// The book learns from the engine's own searches: for a position it keeps each move the
// engine found, with how many nodes the search took. When the engine is about to search a
// position for N nodes and the book has a move searched for at least N, that move is played
// instead (a random one among those within 10 cp of the best). See DESIGN.md, "Opening book".

export interface BookEntry {
  /** key + " " + move */
  id: string;
  /** Position: placement, side to move, castling rights, e.p. square (only if capturable). */
  key: string;
  /** UCI move; castling always written as king takes own rook (as in Chess960). */
  move: string;
  nodes: number;
  depth: number;
  /** Centipawns from the side to move; mates as ±(10000 - moves). */
  score: number;
  /** Net version, e.g. "v11". */
  net: string;
  build: string;
  source: "game" | "analysis" | "seed";
  /** ms since 1970 */
  date: number;
}

export const BOOK_MAX_MOVE = 20; // positions up to move 20
export const BOOK_SPREAD_CP = 10; // moves this close to the best are chosen at random
// A search with the same time does not reach exactly the same node count (speed varies by a
// few percent), so entries count from 85% of the planned nodes on.
export const BOOK_NODE_TOLERANCE = 0.85;

export function bookKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/** Is this FEN a starting position (standard or Chess960) with White to move? */
export function isStartPosition(fen: string): boolean {
  const [placement, side, castling, ep, , full] = fen.split(" ");
  const rows = placement.split("/");
  if (rows.length !== 8 || side !== "w" || ep !== "-" || (full ?? "1") !== "1") return false;
  if (rows[1] !== "pppppppp" || rows[6] !== "PPPPPPPP" || rows.slice(2, 6).some((r) => r !== "8")) return false;
  const back = rows[7];
  if (rows[0] !== back.toLowerCase() || !/^[RNBQK]{8}$/.test(back)) return false;
  const count = (c: string) => back.split(c).length - 1;
  const bishops = [...back].flatMap((c, i) => (c === "B" ? [i % 2] : []));
  const k = back.indexOf("K");
  const rooks = [...back].flatMap((c, i) => (c === "R" ? [i] : []));
  return (
    count("K") === 1 &&
    count("Q") === 1 &&
    count("R") === 2 &&
    count("N") === 2 &&
    bishops.length === 2 &&
    bishops[0] !== bishops[1] &&
    rooks[0] < k &&
    k < rooks[1] &&
    castling.length === 4
  );
}

/** Fullmove number of a FEN. */
export function moveNumber(fen: string): number {
  return Number(fen.split(" ")[5] ?? 1);
}

/** Book move for a search of `budget` nodes, or null. `random` in [0, 1). */
export function chooseBookMove(entries: BookEntry[], budget: number, random = Math.random()): BookEntry | null {
  const deep = entries.filter((e) => e.nodes >= budget * BOOK_NODE_TOLERANCE);
  if (!deep.length) return null;
  const best = Math.max(...deep.map((e) => e.score));
  const near = deep.filter((e) => e.score >= best - BOOK_SPREAD_CP);
  return near[Math.floor(random * near.length)];
}

/** The entry to store for a new search result, given the existing entry for the same move. */
export function shouldStore(existing: BookEntry | undefined, fresh: BookEntry): boolean {
  return !existing || fresh.nodes > existing.nodes;
}

/** Engine score (side to move) as stored in the book. */
export function bookScore(score: { cp: number } | { mate: number }): number {
  if ("mate" in score) return score.mate > 0 ? 10000 - score.mate : -10000 - score.mate;
  return score.cp;
}

/** Checks one entry read from a file. */
export function isBookEntry(x: unknown): x is BookEntry {
  const e = x as BookEntry;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.key === "string" &&
    e.key.split(" ").length === 4 &&
    typeof e.move === "string" &&
    /^[a-h][1-8][a-h][1-8][nbrq]?$/.test(e.move) &&
    typeof e.nodes === "number" &&
    typeof e.score === "number" &&
    e.id === e.key + " " + e.move
  );
}

export const BOOK_FILE_FORMAT = "dark-c-helmet-book";
