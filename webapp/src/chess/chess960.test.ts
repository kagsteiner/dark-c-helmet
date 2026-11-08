import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chess960Fen } from "./chess960.ts";

test("all 960 positions match tools/books/frc960.epd (same numbering as the engine's datagen)", () => {
  const epd = readFileSync("../tools/books/frc960.epd", "utf8").trim().split("\n");
  assert.equal(epd.length, 960);
  for (let n = 0; n < 960; n++) assert.equal(chess960Fen(n), epd[n].trim(), `position ${n}`);
});

test("518 is the standard position", () => {
  assert.equal(chess960Fen(518), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w HAha - 0 1");
});

test("Chess 960²: each side its own back rank and rook files", async () => {
  const { backRank, chess960SquaredFen } = await import("./chess960.ts");
  assert.equal(chess960SquaredFen(518, 518), chess960Fen(518));
  assert.equal(backRank(518), "RNBQKBNR");
  const b = backRank(0); // BBQNNRKR
  assert.equal(b, "BBQNNRKR");
  assert.equal(chess960SquaredFen(518, 0), "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w HAhf - 0 1");
});
