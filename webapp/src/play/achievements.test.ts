import assert from "node:assert/strict";
import { test } from "node:test";
import { earnedFrom, factsOf, gameAchievements, newIn, nextStep, tabOf } from "./achievements.ts";
import type { GameRecord } from "./history.ts";
import type { EvalPoint } from "./report.ts";

function game(over: Partial<GameRecord> & { seconds?: number; used?: number } = {}): GameRecord {
  const { seconds = 1, used = 0, ...rest } = over;
  return {
    id: Math.random().toString(36), started: 0, chess960: false, human: "w", opponent: "engine",
    tc: { kind: "odds", engine: "b", engineSeconds: seconds, humanMinutes: 0 }, outcome: "unfinished", star: "gold",
    plies: 40, odds: { engineSeconds: seconds, humanMinutes: 0, takebacks: 5, used }, ...rest,
  };
}

/** Evaluations after the engine's moves (Black: odd plies), one per value. */
const evals = (...cp: number[]): EvalPoint[] => cp.map((v, i) => ({ ply: 2 * i + 1, e: { cp: v } }));

test("achievements: holding within a pawn needs evaluations through that move", () => {
  const ids = (r: GameRecord) => gameAchievements(r).map((a) => a.id);
  // 20 moves, all within a pawn: holding to move 20, not 30; no evaluation, no holding.
  const held = game({ evals: evals(...Array(20).fill(-50)) });
  assert.equal(factsOf(held).heldUntil, 20);
  assert.deepEqual(ids(held).filter((i) => ["book", "middlegame", "standing", "deep"].includes(i)), ["book", "middlegame", "standing"]);
  assert.ok(!ids(game()).includes("book"));
  // Fell at move 12: held through move 11.
  const fell = game({ evals: [...evals(...Array(11).fill(0)), { ply: 23, e: { cp: -150 } }] });
  assert.equal(factsOf(fell).heldUntil, 11);
  // Enduring counts lost positions; results.
  assert.ok(ids(game({ plies: 60, evals: evals(-900) })).includes("hard-nut"));
  assert.ok(ids(game({ outcome: "win", plies: 80 })).includes("flag"));
  assert.ok(!ids(game({ outcome: "win", plies: 82 })).includes("flag"));
  assert.ok(ids(game({ outcome: "draw", evals: evals(-400, -50) })).includes("swindle"));
  assert.ok(ids(game({ evals: evals(-400, -50) })).includes("comeback"));
  assert.ok(!ids(game({ evals: evals(-50, -400) })).includes("comeback"));
});

test("achievements: runs of foresight, engine's choices and steady moves", () => {
  const f = factsOf(game({
    foresight: { 1: "predicted", 3: "predicted", 5: "considered", 7: "predicted", 9: "predicted", 11: "predicted" },
    found: { 0: true, 2: true, 4: false, 6: true, 8: true, 10: true, 12: true },
    evals: evals(0, -20, -200, -210, -220),
  }));
  assert.equal(f.anticipated, 6);
  assert.equal(f.predictedRun, 3);
  assert.equal(f.found, 6);
  assert.equal(f.foundRun, 4);
  assert.equal(f.steadyRun, 2); // 0 → −20 kept, −20 → −200 lost, then two kept
});

test("achievements: takeback levels and the longest engine time per tab", () => {
  const h = { plies: 40, evals: evals(...Array(20).fill(0)) };
  const records = [
    game({ ...h, seconds: 2, used: 3 }), // Coffeehouse at 2 s
    game({ ...h, seconds: 1, used: 0 }), // Touch-move at 1 s (and the levels before)
    game({ ...h, seconds: 5, used: 1, chess960: true, position960: 7 }),
  ];
  const e = earnedFrom(records);
  assert.deepEqual(e.standard.book, [2, 1, 1]);
  assert.deepEqual(e.chess960.book, [5, 5]);
  assert.equal(e["960x2"].book, undefined);
  assert.equal(tabOf({ chess960: true, position960: 7, black960: 9 }), "960x2");
  assert.equal(nextStep(2), 5);
  assert.equal(nextStep(900), null);
  // Not an odds game: nothing.
  assert.deepEqual(gameAchievements({ ...game(h), odds: undefined }), []);
  // New in a game: the strictest level that beats what was earned before.
  const now = game({ ...h, seconds: 2, used: 0 });
  assert.deepEqual(newIn(now, earnedFrom(records)).find((a) => a.id === "book"), { id: "book", level: 2 });
  const same = game({ ...h, seconds: 1, used: 0 });
  assert.equal(newIn(same, earnedFrom(records)).find((a) => a.id === "book"), undefined);
});
