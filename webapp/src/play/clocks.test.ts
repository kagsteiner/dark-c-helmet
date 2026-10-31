import assert from "node:assert/strict";
import { test } from "node:test";
import { Clocks, formatClock } from "./clocks.ts";

function fakeTime() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("increment is added after each move", () => {
  const time = fakeTime();
  const c = new Clocks({ kind: "game", minutes: 5, increment: 3 }, undefined, time.now);
  c.start("w");
  time.advance(10_000);
  c.moveMade("w");
  assert.equal(c.remaining("w"), 300_000 - 10_000 + 3_000);
  assert.equal(c.runningSide(), "b");
  time.advance(4_000);
  assert.equal(c.remaining("b"), 296_000);
});

test("pause stops the running clock", () => {
  const time = fakeTime();
  const c = new Clocks({ kind: "game", minutes: 1, increment: 0 }, undefined, time.now);
  c.start("w");
  time.advance(5_000);
  c.pause();
  time.advance(60_000);
  assert.equal(c.remaining("w"), 55_000);
});

test("classical: 30 min more after the 40th move, movestogo counts down", () => {
  const time = fakeTime();
  const c = new Clocks({ kind: "classical" }, undefined, time.now);
  c.start("w");
  assert.equal(c.movesToGo("w"), 40);
  for (let i = 0; i < 40; i++) {
    c.moveMade("w");
    c.moveMade("b");
  }
  assert.equal(c.remaining("w"), 90 * 60_000 + 40 * 30_000 + 30 * 60_000);
  assert.equal(c.movesToGo("w"), undefined);
});

test("overstepping goes negative; snapshot restores", () => {
  const time = fakeTime();
  const c = new Clocks({ kind: "game", minutes: 1, increment: 0 }, undefined, time.now);
  c.start("w");
  time.advance(65_000);
  assert.equal(c.remaining("w"), -5_000);
  const d = new Clocks({ kind: "game", minutes: 1, increment: 0 }, c.snapshot(), time.now);
  assert.equal(d.remaining("w"), -5_000);
});

test("formatting", () => {
  assert.equal(formatClock(5 * 60_000), "5:00");
  assert.equal(formatClock(90 * 60_000), "1:30:00");
  assert.equal(formatClock(9_870), "9.8");
  assert.equal(formatClock(-5_000), "-0:05");
});
