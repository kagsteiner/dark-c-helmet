import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Rules } from "../chess/rules.ts";
import { START_FEN } from "../chess/game.ts";
import { bookKey, type BookEntry } from "./book-logic.ts";
import { formatLine, formatNext, formatScore, pickStart, pickWalkMove, Walker, walkMoves } from "./explore.ts";

const rules = await Rules.load(pathToFileURL("public/engine/").href, readFileSync("public/engine/dh-rules.wasm"));
const STANDARD = { fen: START_FEN, chess960: false, number: null };

const entry = (key: string, nodes: number): BookEntry => ({
  id: key + " a2a3",
  key,
  move: "a2a3",
  nodes,
  depth: 30,
  score: 0,
  net: "v12",
  build: "b",
  source: "analysis",
  date: 0,
});

function walker(covered: Map<string, number>, probe: (moves: string[]) => number | null = () => 0, random = () => 0) {
  return new Walker({
    rules,
    lookup: async (key) => (covered.has(key) ? [entry(key, covered.get(key)!)] : []),
    probe: async (pos) => probe(pos.moves),
    cancelled: () => false,
    random,
  });
}

test("the mix decides the variant; the standard position is not a Chess960 start", () => {
  assert.equal(pickStart("standard", () => 0).chess960, false);
  assert.equal(pickStart("chess960", () => 0.999).chess960, true);
  assert.equal(pickStart("mixed", () => 0.8).chess960, false);
  assert.equal(pickStart("chess960", () => 518.5 / 960).number, 519);
});

test("a walk considers moves near the best only", () => {
  const moves = walkMoves([
    { uci: "a", score: 10 },
    { uci: "b", score: 100 },
    { uci: "c", score: 40 },
    { uci: "d", score: 39 },
  ]);
  assert.deepEqual(moves.map((m) => m.uci), ["b", "c"]);
  const many = Array.from({ length: 8 }, (_, i) => ({ uci: String(i), score: 0 }));
  assert.equal(walkMoves(many).length, 4);
});

test("the better move is the more likely one", () => {
  const moves = [{ uci: "a", score: 0 }, { uci: "b", score: 0 }];
  assert.equal(pickWalkMove(moves, () => 0), "a");
  assert.equal(pickWalkMove(moves, () => 0.6), "a");
  assert.equal(pickWalkMove(moves, () => 0.7), "b");
  assert.equal(pickWalkMove([]), null);
});

test("an empty book: the start position is the gap", async () => {
  const game = await walker(new Map()).findGap(STANDARD);
  assert.equal(game?.moves.length, 0);
});

test("a shallow entry leaves a gap, a deep one is walked through", async () => {
  const startKey = bookKey(START_FEN);
  assert.equal((await walker(new Map([[startKey, 49_000_000]])).findGap(STANDARD))?.moves.length, 0);
  // Probes: the score for the opponent, so 1. e4 (-30) is the best move.
  const game = await walker(new Map([[startKey, 50_000_000]]), (m) => (m[0] === "e2e4" ? -30 : 0)).findGap(STANDARD);
  assert.deepEqual(game?.moves.map((m) => m.san), ["e4"]);
});

test("a position searched in this session is not searched again", async () => {
  const w = walker(new Map());
  const first = await w.findGap(STANDARD);
  w.markTried(first!);
  assert.equal((await w.findGap(STANDARD))?.moves.length, 1);
});

test("probes are kept per position", async () => {
  let probes = 0;
  const w = walker(new Map([[bookKey(START_FEN), 60_000_000]]), () => (probes++, 0));
  await w.findGap(STANDARD);
  assert.equal(probes, 20);
  await w.findGap(STANDARD);
  assert.equal(probes, 20);
});

test("a walk ends without a gap when every move ends the game", async () => {
  const w = walker(new Map([[bookKey(START_FEN), 60_000_000]]), () => null);
  assert.equal(await w.findGap(STANDARD), null);
});

test("lines, moves and scores for the list", () => {
  assert.equal(formatLine(["e4", "e5", "Nf3"]), "1. e4 e5 2. Nf3");
  assert.equal(formatLine([]), "");
  assert.equal(formatNext(3, "Nc6"), "2... Nc6");
  assert.equal(formatNext(4, "Bb5"), "3. Bb5");
  assert.equal(formatScore(31, 4), "+0.31");
  assert.equal(formatScore(31, 3), "-0.31");
  assert.equal(formatScore(9995, 0), "#5");
  assert.equal(formatScore(9995, 1), "-#5");
});
