import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, markMoves, whiteCp, winPercent } from "./review.ts";

test("scores from White's view", () => {
  assert.equal(whiteCp({ cp: 35 }, true), 35);
  assert.equal(whiteCp({ cp: 35 }, false), -35);
  assert.equal(whiteCp({ mate: 3 }, false), -9997); // black to move mates in 3
  assert.equal(whiteCp({ mate: -2 }, true), -9998); // white to move gets mated in 2
});

test("winning chances", () => {
  assert.equal(winPercent(0), 50);
  assert.ok(winPercent(300) > 74 && winPercent(300) < 76);
  assert.ok(winPercent(10000) > 99.9);
});

test("classification by drop in winning chances", () => {
  assert.equal(classify(0, -400, true), "blunder");
  assert.equal(classify(0, -120, true), "mistake");
  assert.equal(classify(0, -60, true), "inaccuracy");
  assert.equal(classify(0, -30, true), null);
  assert.equal(classify(800, 650, true), null); // still clearly winning
  assert.equal(classify(0, 400, false), "blunder"); // black move that gives White +4
});

test("marks for a sequence", () => {
  // after 0: 0.2; white plays OK (0.3); black blunders (+4.0); white gives it back (0.0)
  assert.deepEqual(markMoves([20, 30, 400, 0], true), [null, "blunder", "blunder"]);
});
