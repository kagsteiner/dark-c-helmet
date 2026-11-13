import assert from "node:assert/strict";
import { test } from "node:test";
import { balanceOf, formatPawns, STANDARD_START_CP } from "./start-balance.ts";

test("bands are measured from the normal chess start, not from 0.00", () => {
  assert.equal(balanceOf(STANDARD_START_CP).band, 0);
  assert.equal(balanceOf(0).band, -1);
  assert.equal(balanceOf(1).band, 0);
  assert.equal(balanceOf(29).band, 0);
  assert.equal(balanceOf(30).band, 1);
  assert.equal(balanceOf(54).band, 1);
  assert.equal(balanceOf(55).band, 2);
  assert.equal(balanceOf(-24).band, -1);
  assert.equal(balanceOf(-25).band, -2);
  assert.equal(balanceOf(127).band, 2);
  assert.equal(balanceOf(-127).band, -2);
});

test("scores read as pawns for White", () => {
  assert.equal(formatPawns(32), "+0.32");
  assert.equal(formatPawns(-5), "-0.05");
  assert.equal(formatPawns(0), "+0.00");
});
