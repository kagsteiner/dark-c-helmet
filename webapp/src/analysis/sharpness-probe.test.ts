import assert from "node:assert/strict";
import { test } from "node:test";
import { nearEdge } from "./sharpness-probe.ts";

test("second look: only the moves near the one-pawn edge", () => {
  // best 50: the edge is at -50; within 50 of it: 0 and -60 and -100, not 40 or -200
  assert.deepEqual(nearEdge([50, 40, 0, -60, -100, -200]), [2, 3, 4]);
});

test("the best move's known score is not looked at again", () => {
  // best -40: the edge at -140; -120 and -150 are near it
  assert.deepEqual(nearEdge([-120, -40, -150]), [0, 2]);
  assert.deepEqual(nearEdge([-120, -40, -150], 0), [2]);
});

test("scores beyond three pawns are clamped first", () => {
  // a mate and a won position: both at +300, the edge at +200
  assert.deepEqual(nearEdge([10000, 900, 210, 100]), [2]);
});
