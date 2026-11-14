import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Rules } from "../chess/rules.ts";

const rules = await Rules.load(pathToFileURL("public/engine/").href, readFileSync("public/engine/dh-rules.wasm"));

test("hanging: pieces lost in the exchange, both colours, not the defended ones", () => {
  // White to move. Hanging: Black's knight e5 (the d4 pawn takes it), Black's b5 pawn (the
  // c3 knight takes it, nothing defends it) and White's bishop a4 (after a null move the b5
  // pawn takes it). Not hanging: f7, attacked by the queen but defended by the king.
  rules.setFen("r1bqk2r/p1pp1ppp/8/1p2n2Q/B2P4/2N5/PPP2PPP/R1B1K1NR w KQkq - 0 1", false);
  const h = rules.hanging().sort((a, b) => a - b);
  assert.deepEqual(h, [24, 33, 36]); // a4, b5, e5
});

test("hanging: nothing in the start position; null move not possible in check", () => {
  rules.setFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", false);
  assert.deepEqual(rules.hanging(), []);
  assert.equal(rules.nullFen()?.split(" ")[1], "b");
  rules.setFen("4k3/8/8/8/8/8/4r3/4K3 w - - 0 1", false);
  assert.equal(rules.nullFen(), null);
});
