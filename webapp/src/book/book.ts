// The opening book in IndexedDB: lookup, recording search results, statistics, export, merge.
import type { Game } from "../chess/game.ts";
import type { LegalMove } from "../chess/rules.ts";
import type { Engine, SearchInfo, SearchResult } from "../engine/engine.ts";
import { BOOK_STORE, db, request } from "../storage.ts";
import { offerEntry } from "./contrib-client.ts";
import {
  BOOK_FILE_FORMAT,
  BOOK_MAX_MOVE,
  bookKey,
  bookMoveName,
  bookScore,
  chooseBookMove,
  isBookEntry,
  isStartPosition,
  moveNumber,
  shouldStore,
  type BookEntry,
} from "./book-logic.ts";

/** Does the book cover the current position of this game? (Games from a start position, up
 *  to move 20.) */
export function inBookRange(game: Game): boolean {
  return isStartPosition(game.startFen) && moveNumber(game.fen()) <= BOOK_MAX_MOVE;
}

export async function lookup(key: string): Promise<BookEntry[]> {
  try {
    return await request<BookEntry[]>(BOOK_STORE, "readonly", (s) => s.index("key").getAll(key));
  } catch {
    return [];
  }
}

/** A book move for the game's position worth at least `nodes`, as a UCI move of the game.
 *  `strongest`: the best-scored move rather than a random one among the near-best. */
/** The book's move for this search budget; `shallow`: the book knows the position, but none
 *  of its moves was searched as deeply as this search would be. */
export async function bookMove(game: Game, nodes: number, strongest = false): Promise<{ uci: string | null; shallow: boolean }> {
  if (!inBookRange(game)) return { uci: null, shallow: false };
  const fen = game.fen();
  const entries = await lookup(bookKey(fen));
  const entry = chooseBookMove(entries, nodes, moveNumber(fen), Math.random(), strongest);
  if (!entry) return { uci: null, shallow: entries.length > 0 };
  return { uci: game.legalMoves().find((m) => bookMoveName(m) === entry.move)?.uci ?? null, shallow: false };
}

async function put(entry: BookEntry): Promise<"added" | "updated" | "kept"> {
  const existing = await request<BookEntry | undefined>(BOOK_STORE, "readonly", (s) => s.get(entry.id));
  if (!shouldStore(existing, entry)) return "kept";
  await request(BOOK_STORE, "readwrite", (s) => s.put(entry));
  return existing ? "updated" : "added";
}

/** Stores an entry; new or deeper than what the book had: also a candidate for the master book. */
async function store(entry: BookEntry): Promise<void> {
  try {
    if ((await put(entry)) !== "kept") await offerEntry(entry);
  } catch {
    // storage unavailable: the book just does not learn
  }
}

function makeEntry(fen: string, move: LegalMove, info: SearchInfo, nodes: number, score: number, engine: Engine, source: BookEntry["source"]): BookEntry {
  const key = bookKey(fen);
  const name = bookMoveName(move);
  return {
    id: key + " " + name,
    key,
    move: name,
    nodes,
    depth: info.depth,
    score,
    net: engine.net,
    build: engine.name,
    source,
    date: Date.now(),
  };
}

/** Records a finished search of the game's current position (before the move is played). */
export async function record(game: Game, result: SearchResult, engine: Engine, source: BookEntry["source"]): Promise<void> {
  const info = result.info;
  if (!info || !result.bestmove || !inBookRange(game)) return;
  const move = game.legalMoves().find((m) => m.uci === result.bestmove);
  if (!move) return;
  await store(makeEntry(game.fen(), move, info, result.nodes || info.nodes, bookScore(info.score), engine, source));
}

/** A finished search of the game's current position also scores the move that led to it (as in
 *  the seed book), so the book knows more than the best move of each position. */
export async function recordMoveLeadingHere(game: Game, result: SearchResult, engine: Engine, source: BookEntry["source"]): Promise<void> {
  const info = result.info;
  const last = game.moves[game.moves.length - 1];
  if (!info || !last) return;
  game.undo();
  const move = game.legalMoves().find((m) => m.uci === last.uci);
  const entry = move && inBookRange(game) ? makeEntry(game.fen(), move, info, result.nodes || info.nodes, -bookScore(info.score), engine, source) : null;
  game.play(last.uci);
  if (entry) await store(entry);
}

export async function allEntries(): Promise<BookEntry[]> {
  return request<BookEntry[]>(BOOK_STORE, "readonly", (s) => s.getAll());
}

export interface BookStats {
  positions: number;
  moves: number;
  maxNodes: number;
  byNet: Record<string, number>;
  bySource: Record<string, number>;
}

export async function stats(): Promise<BookStats> {
  const entries = await allEntries();
  const s: BookStats = { positions: new Set(entries.map((e) => e.key)).size, moves: entries.length, maxNodes: 0, byNet: {}, bySource: {} };
  for (const e of entries) {
    s.maxNodes = Math.max(s.maxNodes, e.nodes);
    s.byNet[e.net || "?"] = (s.byNet[e.net || "?"] ?? 0) + 1;
    s.bySource[e.source] = (s.bySource[e.source] ?? 0) + 1;
  }
  return s;
}

export async function exportBook(): Promise<Blob> {
  const entries = await allEntries();
  const file = { format: BOOK_FILE_FORMAT, version: 1, exported: new Date().toISOString(), entries };
  return new Blob([JSON.stringify(file)], { type: "application/json" });
}

export interface MergeResult {
  added: number;
  updated: number;
  kept: number;
  invalid: number;
}

/** Merges a book file: for the same position and move the deeper search wins. */
export async function mergeBook(text: string): Promise<MergeResult> {
  let file: { format?: string; entries?: unknown[] };
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error("This file is not a book file (not valid JSON).");
  }
  if (file.format !== BOOK_FILE_FORMAT || !Array.isArray(file.entries)) throw new Error("This file is not a Dark C. Helmet book.");
  return mergeEntries(file.entries);
}

/** Merges entries into the book: for the same position and move the deeper search wins. */
export async function mergeEntries(incoming: unknown[]): Promise<MergeResult> {
  const result: MergeResult = { added: 0, updated: 0, kept: 0, invalid: 0 };
  const existing = new Map((await allEntries()).map((e) => [e.id, e]));
  const writes: BookEntry[] = [];
  for (const e of incoming) {
    if (!isBookEntry(e)) {
      result.invalid++;
      continue;
    }
    const old = existing.get(e.id);
    if (!shouldStore(old, e)) {
      result.kept++;
      continue;
    }
    result[old ? "updated" : "added"]++;
    existing.set(e.id, e);
    writes.push(e);
  }
  // One transaction for all writes (a book can have 100 000+ entries).
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(BOOK_STORE, "readwrite");
    const store = tx.objectStore(BOOK_STORE);
    for (const e of writes) store.put(e);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return result;
}

export async function clearBook(): Promise<void> {
  await request(BOOK_STORE, "readwrite", (s) => s.clear());
}
