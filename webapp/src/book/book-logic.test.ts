import assert from "node:assert/strict";
import { test } from "node:test";
import { chess960Fen } from "../chess/chess960.ts";
import { START_FEN } from "../chess/game.ts";
import { bookKey, chooseBookMove, isBookEntry, isStartPosition, shouldStore, type BookEntry } from "./book-logic.ts";

const KEY = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
const entry = (move: string, nodes: number, score: number): BookEntry => ({
  id: KEY + " " + move,
  key: KEY,
  move,
  nodes,
  depth: 20,
  score,
  net: "v11",
  build: "test",
  source: "game",
  date: 0,
});

test("key keeps placement, side, castling, e.p.", () => {
  assert.equal(bookKey(START_FEN), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
});

test("start positions", () => {
  assert.equal(isStartPosition(START_FEN), true);
  for (const n of [0, 100, 518, 959]) assert.equal(isStartPosition(chess960Fen(n)), true, String(n));
  assert.equal(isStartPosition("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"), false);
  assert.equal(isStartPosition(START_FEN.replace(" w ", " b ")), false);
});

test("book move needs at least half the planned nodes", () => {
  const entries = [entry("e2e4", 1_000_000, 30), entry("d2d4", 5_000_000, 25)];
  assert.equal(chooseBookMove(entries, 2_000_000, 1, 0, true)?.move, "e2e4");
  assert.equal(chooseBookMove(entries, 2_000_002, 1, 0, true)?.move, "d2d4");
  assert.equal(chooseBookMove(entries, 10_000_000, 1, 0, true)?.move, "d2d4");
  assert.equal(chooseBookMove(entries, 10_000_002), null);
});

test("random choice among moves within 10 cp of the best, 30 cp up to move 5", () => {
  const entries = [entry("e2e4", 9e6, 30), entry("d2d4", 9e6, 22), entry("b2b3", 9e6, 5), entry("g2g4", 9e6, -50)];
  assert.equal(chooseBookMove(entries, 1e6, 10, 0)?.move, "e2e4");
  assert.equal(chooseBookMove(entries, 1e6, 10, 0.99)?.move, "d2d4");
  // in the opening b2b3 (25 cp below the best) is a candidate too, g2g4 (80 below) is not
  assert.deepEqual(
    [0, 0.4, 0.99].map((r) => chooseBookMove(entries, 1e6, 3, r)?.move),
    ["e2e4", "d2d4", "b2b3"],
  );
  // "Strongest": always the best-scored move
  assert.deepEqual([0, 0.5, 0.99].map((r) => chooseBookMove(entries, 1e6, 3, r, true)?.move), ["e2e4", "e2e4", "e2e4"]);
});

test("an entry is replaced only by a deeper search", () => {
  assert.equal(shouldStore(undefined, entry("e2e4", 1, 0)), true);
  assert.equal(shouldStore(entry("e2e4", 5, 0), entry("e2e4", 9, 0)), true);
  assert.equal(shouldStore(entry("e2e4", 9, 0), entry("e2e4", 5, 0)), false);
});

test("file entries are checked", () => {
  assert.equal(isBookEntry(entry("e2e4", 1, 0)), true);
  assert.equal(isBookEntry({ ...entry("e2e4", 1, 0), move: "xx" }), false);
  assert.equal(isBookEntry(null), false);
});

test("sharp style: among the near-best moves, the narrowest path for the opponent", () => {
  const entries = [entry("e2e4", 9e6, 30), entry("d2d4", 9e6, 22), entry("b2b3", 9e6, 5), entry("g2g4", 9e6, 0)];
  const known: Record<string, { n: number; gap: number; legal: number }> = {
    e2e4: { n: 5, gap: 10, legal: 30 },
    d2d4: { n: 2, gap: 80, legal: 30 },
    b2b3: { n: 1, gap: 200, legal: 30 }, // narrowest, but 25 cp below the best: still inside 30 cp
    g2g4: { n: 1, gap: 300, legal: 30 }, // 30 cp below the best: inside; narrower still
  };
  const sharp = (e: BookEntry) => known[e.move];
  assert.equal(chooseBookMove(entries, 1e6, 12, 0, false, sharp)?.move, "g2g4");
  // 31 cp or more below the best never makes it, whatever its sharpness
  assert.equal(chooseBookMove([...entries.slice(0, 3), entry("a2a3", 9e6, -5)], 1e6, 12, 0, false, (e) => (e.move === "a2a3" ? { n: 1, gap: 500, legal: 30 } : known[e.move]))?.move, "b2b3");
  // unknown positions count as robust; with nothing known the choice is random among the near ones
  assert.deepEqual([0, 0.3, 0.6, 0.99].map((r) => chooseBookMove(entries, 1e6, 12, r, false, () => undefined)?.move), ["e2e4", "d2d4", "b2b3", "g2g4"]);
  // the depth rule still applies first
  assert.equal(chooseBookMove([entry("e2e4", 1, 30), entry("d2d4", 9e6, 22)], 1e7, 12, 0, false, sharp)?.move, "d2d4");
});
