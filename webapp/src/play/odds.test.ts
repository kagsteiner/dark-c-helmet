import assert from "node:assert/strict";
import { test } from "node:test";
import { Clocks, describeTimeControl, noClock, type TimeControl } from "./clocks.ts";
import { countsAsWin, type GameRecord } from "./history.ts";
import { oddsName, tallyByOdds } from "./odds-log.ts";

test("odds clock: the engine's own time, no clock for the player in correspondence", () => {
  let now = 0;
  const tc: TimeControl = { kind: "odds", engine: "b", engineSeconds: 5, humanMinutes: 0 };
  const c = new Clocks(tc, undefined, () => now);
  assert.equal(c.remaining("b"), 5000);
  assert.ok(c.remaining("w") > 1e9);
  assert.ok(noClock(tc));
  c.start("w");
  now += 3_600_000; // an hour of thinking costs the player nothing that matters
  c.moveMade("w");
  assert.ok(c.remaining("w") > 1e9);
  now += 400;
  c.moveMade("b");
  assert.equal(c.remaining("b"), 4600); // no increment
  assert.match(describeTimeControl(tc), /engine 5 s per game · you no clock/);
  const timed: TimeControl = { kind: "odds", engine: "w", engineSeconds: 60, humanMinutes: 15 };
  const t = new Clocks(timed, undefined, () => now);
  assert.equal(t.remaining("w"), 60_000);
  assert.equal(t.remaining("b"), 15 * 60_000);
  assert.ok(!noClock(timed));
});

function rec(outcome: GameRecord["outcome"], takebacks: number, used: number, star: GameRecord["star"] = "gold"): GameRecord {
  return {
    id: Math.random().toString(36), started: 0, chess960: true, position960: 518, human: "w", opponent: "engine",
    tc: { kind: "odds", engine: "b", engineSeconds: 5, humanMinutes: 0 }, outcome, star, plies: 60,
    odds: { engineSeconds: 5, humanMinutes: 0, takebacks, used },
  };
}

test("odds log: games tallied by their odds; they do not count on the Progress screen", () => {
  const records = [rec("win", 3, 1), rec("loss", 3, 3), rec("draw", 3, 0), rec("win", 0, 0, null), { ...rec("win", 0, 0), odds: undefined }];
  const t = tallyByOdds(records);
  assert.equal(t.length, 2);
  assert.equal(t[0].name, "engine 5 s · no clock · 3 takebacks");
  assert.deepEqual([t[0].games, t[0].wins, t[0].draws, t[0].losses, t[0].starredWins], [3, 1, 1, 1, 1]);
  assert.equal(t[1].name, "engine 5 s · no clock · no takebacks");
  assert.equal(t[1].starredWins, 0);
  assert.equal(oddsName({ engineSeconds: 90, humanMinutes: 15, takebacks: 1 }), "engine 1 min 30 s · you 15 min · 1 takeback");
  assert.equal(countsAsWin(records[0]), false);
  assert.equal(countsAsWin(records[4]), true);
});
