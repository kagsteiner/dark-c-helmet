import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Game } from "./game.ts";
import { Rules } from "./rules.ts";

const rules = await Rules.load(pathToFileURL("public/engine/").href, readFileSync("public/engine/dh-rules.wasm"));

test("Game: keeps its position when someone else uses the shared rules module", () => {
  const game = new Game(rules);
  game.play("e2e4");
  game.play("e7e6");
  assert.equal(game.turn(), "w");
  // The analysis grid (or anything else) uses the same module directly …
  rules.setFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", false);
  rules.play("d2d4");
  // … and the game still knows its own position.
  assert.equal(game.turn(), "w");
  assert.equal(game.fen().split(" ")[0], "rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR");
  // Another game in between, too.
  const other = new Game(rules);
  other.play("g1f3");
  assert.ok(game.play("d2d4"));
  assert.equal(game.turn(), "b");
  assert.equal(other.turn(), "b");
  assert.equal(game.moves.length, 3);
});
