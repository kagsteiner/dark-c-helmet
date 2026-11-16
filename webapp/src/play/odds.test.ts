import assert from "node:assert/strict";
import { test } from "node:test";
import { Clocks, describeTimeControl, noClock, type TimeControl } from "./clocks.ts";
import { countsAsWin, type GameRecord } from "./history.ts";
import { evalText, oddsGameLine, oddsName, recordReport, tallyByOdds } from "./odds-log.ts";
import { makeReport, reportText } from "./report.ts";

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

test("odds log: an unfinished game shows how it stood, from the player's point of view", () => {
  assert.equal(evalText({ cp: -430 }), "−4.30");
  assert.equal(evalText({ cp: 35 }), "+0.35");
  assert.equal(evalText({ mate: 3 }), "you mate in 3");
  assert.equal(evalText({ mate: -2 }), "mated in 2");
  const left = { ...rec("unfinished", 3, 3), engineEval: { cp: -512 } };
  assert.match(oddsGameLine(left), /not finished · 30 moves · engine's eval for you −5\.12$/);
  // A finished game says how it ended; no evaluation.
  assert.doesNotMatch(oddsGameLine({ ...rec("loss", 3, 3), engineEval: { mate: -1 } }), /eval/);
});

test("clock refund: a move that cost no thinking gives the time back", () => {
  let now = 0;
  const c = new Clocks({ kind: "odds", engine: "b", engineSeconds: 1, humanMinutes: 0 }, undefined, () => now);
  c.start("b");
  now += 320; // a book move: lookup and the pause to show both moves
  c.refund("b", 320);
  c.moveMade("b");
  assert.equal(c.remaining("b"), 1000);
  c.start("b");
  now += 40; // a real search
  c.moveMade("b");
  assert.equal(c.remaining("b"), 960);
});

test("report card: held until, worst moment, foresight, takebacks", () => {
  // Engine moves at odd plies (the player is White): evals after moves 1, 2, 3, 4.
  const evals = [
    { ply: 1, e: { cp: -20 } },
    { ply: 3, e: { cp: -80 } },
    { ply: 5, e: { cp: -150 } }, // move 3: below -1.00
    { ply: 7, e: { cp: -90 } },
  ];
  const foresight = { 1: "predicted", 3: "considered", 5: "missed", 7: "considered" } as const;
  const r = makeReport(8, evals, foresight, { used: 2, of: 3 });
  assert.equal(r.fellAt, 3);
  assert.deepEqual(r.worst, { e: { cp: -150 }, move: 3 });
  assert.deepEqual([r.judged, r.considered, r.predicted], [4, 3, 1]);
  assert.equal(
    reportText(r, true),
    "above −1.00 until move 3 · worst −1.50 at move 3 · foresaw 3 of 4 engine replies (1 as your main line) · " +
      "1 of 3 moves without losing ground · 2 of 3 takebacks",
  );
  // Held all game; a mate counts as worse than any score.
  const held = makeReport(10, [{ ply: 1, e: { cp: 30 } }], undefined, null);
  assert.equal(reportText(held, true), "above −1.00 all 5 moves");
  const mated = makeReport(10, [{ ply: 1, e: { cp: -900 } }, { ply: 9, e: { mate: -2 } }], undefined, null);
  assert.equal(mated.worst?.move, 5);
  assert.match(reportText(mated, true), /worst mated in 2 at move 5/);
  // A recorded game.
  assert.equal(recordReport({ ...rec("unfinished", 3, 1), evals, foresight }), reportText(makeReport(60, evals, foresight, { used: 1, of: 3 }), true));
  assert.equal(recordReport({ ...rec("unfinished", 0, 0), odds: undefined }), "");
});

test("report card: the engine's expected move found; ground lost, mates capped", () => {
  const r = makeReport(10, undefined, undefined, null, { 2: true, 4: false, 6: true });
  assert.deepEqual(r.found, { yes: 2, of: 3 });
  assert.equal(reportText(r, false), "found the engine's move 2 of 3 times");
  // Gaps (a book move without evaluation) are skipped; a lost game's mate scores count as -10.
  const evals = [
    { ply: 1, e: { cp: 0 } },
    { ply: 3, e: { cp: -40 } }, // -0.40: not lost ground
    { ply: 7, e: { cp: -1200 } }, // no evaluation at ply 5: not judged
    { ply: 9, e: { mate: -3 } }, // -12 to mated: both capped at -10
  ];
  assert.deepEqual(makeReport(10, evals, undefined, null).steady, { yes: 2, of: 2 });
});
