// The opening book in IndexedDB: lookup, recording search results, statistics, export, merge.
import type { Game } from "../chess/game.ts";
import type { Engine, SearchResult } from "../engine/engine.ts";
import { BOOK_STORE, db, request } from "../storage.ts";
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

/** A book move for the game's position worth at least `nodes`, as a UCI move of the game. */
export async function bookMove(game: Game, nodes: number): Promise<string | null> {
  if (!inBookRange(game)) return null;
  const entry = chooseBookMove(await lookup(bookKey(game.fen())), nodes);
  if (!entry) return null;
  return game.legalMoves().find((m) => bookMoveName(m) === entry.move)?.uci ?? null;
}

async function put(entry: BookEntry): Promise<"added" | "updated" | "kept"> {
  const existing = await request<BookEntry | undefined>(BOOK_STORE, "readonly", (s) => s.get(entry.id));
  if (!shouldStore(existing, entry)) return "kept";
  await request(BOOK_STORE, "readwrite", (s) => s.put(entry));
  return existing ? "updated" : "added";
}

/** Records a finished search of the game's current position (before the move is played). */
export async function record(game: Game, result: SearchResult, engine: Engine, source: BookEntry["source"]): Promise<void> {
  const info = result.info;
  if (!info || !result.bestmove || !inBookRange(game)) return;
  const move = game.legalMoves().find((m) => m.uci === result.bestmove);
  if (!move) return;
  const key = bookKey(game.fen());
  const name = bookMoveName(move);
  try {
    await put({
      id: key + " " + name,
      key,
      move: name,
      nodes: result.nodes || info.nodes,
      depth: info.depth,
      score: bookScore(info.score),
      net: engine.net,
      build: engine.name,
      source,
      date: Date.now(),
    });
  } catch {
    // storage unavailable: the book just does not learn
  }
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
  const result: MergeResult = { added: 0, updated: 0, kept: 0, invalid: 0 };
  const existing = new Map((await allEntries()).map((e) => [e.id, e]));
  const writes: BookEntry[] = [];
  for (const e of file.entries) {
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
