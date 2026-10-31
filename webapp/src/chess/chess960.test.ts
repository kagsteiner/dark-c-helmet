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
