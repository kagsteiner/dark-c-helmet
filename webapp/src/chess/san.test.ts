// Run with `npm test` (needs the rules module: `npm run engine`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Game } from "./game.ts";
import { Rules } from "./rules.ts";

const rules = await Rules.load(pathToFileURL("public/engine/").href, readFileSync("public/engine/dh-rules.wasm"));

function sans(fen: string | undefined, uci: string[], chess960 = false): string[] {
  const game = new Game(rules, fen, chess960);
  return uci.map((m) => {
    const played = game.play(m);
    assert.ok(played, `illegal move ${m}`);
    return played.san;
  });
}

test("pawn moves, captures, check", () => {
  assert.deepEqual(sans(undefined, ["e2e4", "d7d5", "e4d5", "d8d5", "b1c3", "d5e5", "f1e2"]), [
    "e4", "d5", "exd5", "Qxd5", "Nc3", "Qe5+", "Be2",
  ]);
  assert.deepEqual(sans(undefined, ["e2e4", "f7f6", "d1h5"]), ["e4", "f6", "Qh5+"]);
});

test("mate", () => {
  assert.deepEqual(sans(undefined, ["f2f3", "e7e5", "g2g4", "d8h4"]), ["f3", "e5", "g4", "Qh4#"]);
});

test("castling, standard and Chess960", () => {
  assert.deepEqual(sans("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", ["e1g1", "e8c8"]), ["O-O", "O-O-O"]);
  // Chess960: king b1, rooks a1 and g1; UCI castling is king takes own rook.
  assert.deepEqual(sans("4k3/8/8/8/8/8/8/RK4R1 w GA - 0 1", ["b1g1"], true), ["O-O"]);
  assert.deepEqual(sans("4k3/8/8/8/8/8/8/RK4R1 w GA - 0 1", ["b1a1"], true), ["O-O-O"]);
});

test("disambiguation by file, rank, square", () => {
  assert.deepEqual(sans("4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1", ["b1d2"]), ["Nbd2"]);
  assert.deepEqual(sans("4k3/8/8/R7/8/8/8/R3K3 w - - 0 1", ["a1a3"]), ["R1a3"]);
  assert.deepEqual(sans("6k1/8/8/8/Q6Q/8/8/Q3K3 w - - 0 1", ["h4d4"]), ["Qhd4"]);
  assert.deepEqual(sans("6k1/8/8/8/Q6Q/8/8/Q3K3 w - - 0 1", ["a4d4"]), ["Qa4d4"]);
});

test("promotion and en passant", () => {
  assert.deepEqual(sans("1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1", ["a7a8q", "e8d7", "a8b8"]), ["a8=Q", "Kd7", "Qxb8"]);
  assert.deepEqual(sans("1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1", ["a7b8n"]), ["axb8=N"]);
  assert.deepEqual(sans("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", ["e5d6"]), ["exd6"]);
});

test("replay after another game used the rules module", () => {
  const a = new Game(rules);
  a.play("e2e4");
  const b = new Game(rules);
  b.play("d2d4");
  assert.equal(a.play("e7e5")?.san, "e5");
  assert.equal(a.fen().split(" ")[0], "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR");
  assert.equal(a.undo()?.uci, "e7e5");
  assert.equal(b.turn(), "b");
});
