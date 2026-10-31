import assert from "node:assert/strict";
import { test } from "node:test";
import { chess960Fen } from "./chess960.ts";
import { START_FEN } from "./game.ts";
import { epCandidates, fromFen, needsChess960, normalizeCastling, problems, toFen } from "./position-edit.ts";

test("FEN round trip: standard start, Chess960 start, en passant", () => {
  assert.equal(toFen(fromFen(START_FEN)!), START_FEN);
  // Chess960 starts are written with rook files.
  assert.equal(toFen(fromFen(chess960Fen(0))!), chess960Fen(0));
  const ep = "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 1";
  assert.equal(toFen(fromFen(ep)!), ep);
  assert.equal(needsChess960(fromFen(START_FEN)!), false);
  assert.equal(needsChess960(fromFen(chess960Fen(0))!), true);
});

test("en passant candidates", () => {
  const pos = fromFen("4k3/8/8/3pPp2/8/8/8/4K3 w - - 0 1")!;
  assert.deepEqual(epCandidates(pos), [43, 45]); // d6, f6
});

test("castling rights that do not fit the pieces are dropped", () => {
  const pos = fromFen("4k3/8/8/8/8/8/8/4K2R w KQ - 0 1")!;
  normalizeCastling(pos);
  assert.deepEqual(pos.castling, { K: true, Q: false, k: false, q: false });
  assert.equal(toFen(pos), "4k3/8/8/8/8/8/8/4K2R w K - 0 1");
});

test("problems", () => {
  assert.deepEqual(problems(fromFen("8/8/8/8/8/8/8/4K3 w - - 0 1")!, () => false), ["Black needs exactly one king."]);
  assert.deepEqual(problems(fromFen("4k3/8/8/8/8/8/8/P3K3 w - - 0 1")!, () => false), [
    "Pawns cannot stand on the first or last rank.",
  ]);
  assert.deepEqual(problems(fromFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1")!, () => true), [
    "Black is in check but it is not their move.",
  ]);
  assert.equal(fromFen("not a fen"), null);
});
