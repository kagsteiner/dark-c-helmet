import assert from "node:assert/strict";
import { test } from "node:test";
import { allWonAgainstEngine, countsAsWin, level, outcomeOf, progressByPosition, type GameRecord } from "./history.ts";

function rec(r: Partial<GameRecord>): GameRecord {
  return {
    id: Math.random().toString(36),
    started: 0,
    chess960: true,
    position960: 7,
    human: "w",
    opponent: "engine",
    tc: { kind: "classical" },
    outcome: "loss",
    star: null,
    plies: 40,
    ...r,
  };
}

test("outcome from the result text", () => {
  assert.equal(outcomeOf(null), "unfinished");
  assert.equal(outcomeOf("Checkmate. You win."), "win");
  assert.equal(outcomeOf("The engine resigns. You win."), "win");
  assert.equal(outcomeOf("Checkmate. The engine wins."), "loss");
  assert.equal(outcomeOf("Draw by stalemate."), "draw");
});

test("a tile shows the strongest opponent beaten with the star", () => {
  const p = progressByPosition([
    rec({ opponent: "1300", outcome: "win", star: "gold" }),
    rec({ opponent: "1600", outcome: "win", star: null }), // won with help: does not count
    rec({ opponent: "engine", outcome: "loss" }),
    rec({ human: "b", opponent: "1600", outcome: "win", star: "gold" }),
  ]).get(7);
  assert.equal(level(p, "w", null), 1);
  assert.equal(level(p, "b", null), 2);
  assert.equal(level(p, "w", "1600"), 0); // played, no starred win
  assert.equal(level(p, "w", "engine"), 0);
  assert.equal(level(p, "b", "1300"), -1); // not played
  assert.equal(p!.games.w["1300"].wins, 1);
});

test("a silver star is enough against the engine only", () => {
  assert.equal(countsAsWin({ outcome: "win", star: "silver", opponent: "engine" }), true);
  assert.equal(countsAsWin({ outcome: "win", star: "silver", opponent: "1600" }), false);
  assert.equal(countsAsWin({ outcome: "win", star: "gold", opponent: "1300" }), true);
  assert.equal(countsAsWin({ outcome: "draw", star: "gold", opponent: "engine" }), false);
  const p = progressByPosition([
    rec({ opponent: "1600", outcome: "win", star: "silver" }),
    rec({ opponent: "engine", outcome: "win", star: "silver" }),
  ]).get(7);
  assert.equal(level(p, "w", "1600"), 0);
  assert.equal(level(p, "w", null), 3);
});

test("all 960 positions won against the engine, with either colour", () => {
  const all = Array.from({ length: 960 }, (_, n) =>
    rec({ position960: n, human: n % 2 ? "b" : "w", opponent: "engine", outcome: "win", star: "silver" }),
  );
  assert.equal(allWonAgainstEngine(progressByPosition(all)), true);
  all[500] = rec({ position960: 500, opponent: "1600", outcome: "win", star: "gold" });
  assert.equal(allWonAgainstEngine(progressByPosition(all)), false);
});

test("standard games and positions without a number are left out", () => {
  const m = progressByPosition([rec({ chess960: false, position960: undefined }), rec({ position960: undefined })]);
  assert.equal(m.size, 0);
  assert.equal(level(undefined, "w", null), -1);
});
