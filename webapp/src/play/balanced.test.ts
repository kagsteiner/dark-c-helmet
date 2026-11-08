import assert from "node:assert/strict";
import { test } from "node:test";
import { isBalanced, pickPair } from "./balanced.ts";

test("without a list every pair is allowed", () => {
  assert.equal(isBalanced(null, 3, 900), true);
  const [w, b] = pickPair(null, () => 0.5);
  assert.deepEqual([w, b], [480, 0]);
});

test("a pair is picked from the set bits only", () => {
  const bits = new Uint8Array((960 * 960) / 8);
  const set = (w: number, b: number) => {
    const i = w * 960 + b;
    bits[i >> 3] |= 1 << (i & 7);
  };
  set(518, 104);
  set(7, 959);
  set(959, 0);
  assert.equal(isBalanced(bits, 518, 104), true);
  assert.equal(isBalanced(bits, 104, 518), false);
  assert.deepEqual(pickPair(bits, () => 0), [7, 959]);
  assert.deepEqual(pickPair(bits, () => 0.5), [518, 104]);
  assert.deepEqual(pickPair(bits, () => 0.99), [959, 0]);
});
