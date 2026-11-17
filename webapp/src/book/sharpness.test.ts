import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareNarrowness,
  computeSharpness,
  isSharpRecord,
  mergeSharpRecords,
  sharpBand,
  type SharpRecord,
} from "./sharpness.ts";

test("counts the moves within a pawn of the best", () => {
  assert.deepEqual(computeSharpness([50, 40, -60, -90]), { n: 2, gap: 10, legal: 4 });
  assert.deepEqual(computeSharpness([50, 150, -20]), { n: 2, gap: 100, legal: 3 }); // 50 is 100 behind 150: counts
  assert.equal(computeSharpness([10, -150, -300, -500])!.n, 1);
});

test("scores beyond three pawns do not matter", () => {
  // A won position: all of these win, so the position is robust, not sharp.
  assert.equal(computeSharpness([900, 700, 450, 320])!.n, 4);
  // Mates count as three pawns.
  assert.deepEqual(computeSharpness([9990, 9980, 0]), { n: 2, gap: 0, legal: 3 });
  assert.equal(sharpBand(computeSharpness([9990, 9980, 0])!), "very-sharp");
});

test("the gap is the cost of the first mistake", () => {
  assert.equal(computeSharpness([300, -300])!.gap, 600);
  assert.equal(computeSharpness([30, 20, 10, 0])!.gap, 10);
});

test("bands", () => {
  assert.equal(sharpBand({ n: 1, gap: 200, legal: 20 }), "forced");
  assert.equal(sharpBand({ n: 2, gap: 80, legal: 20 }), "very-sharp");
  assert.equal(sharpBand({ n: 3, gap: 80, legal: 20 }), "sharp");
  assert.equal(sharpBand({ n: 4, gap: 0, legal: 20 }), "robust");
  assert.equal(sharpBand({ n: 1, gap: 0, legal: 1 }), "nochoice");
});

test("no moves, no sharpness", () => {
  assert.equal(computeSharpness([]), null);
});

test("narrower is lower; unknown and no choice count as robust", () => {
  const forced = { n: 1, gap: 200, legal: 20 };
  const forcedSmall = { n: 1, gap: 30, legal: 20 };
  const sharp = { n: 3, gap: 100, legal: 20 };
  assert.ok(compareNarrowness(forced, forcedSmall) < 0);
  assert.ok(compareNarrowness(forcedSmall, sharp) < 0);
  assert.equal(compareNarrowness(undefined, { n: 5, gap: 0, legal: 30 }), 0);
  assert.equal(compareNarrowness({ n: 1, gap: 0, legal: 1 }, undefined), 0);
  assert.ok(compareNarrowness(sharp, undefined) < 0);
});

test("the record with more nodes wins", () => {
  const rec = (key: string, nodes: number, n = 2): SharpRecord => ({ key, n, gap: 10, legal: 20, nodes, net: "v12" });
  const m = new Map<string, SharpRecord>();
  assert.deepEqual(mergeSharpRecords(m, [rec("a b c d", 100), rec("e f g h", 100)]), { added: 2, updated: 0, kept: 0 });
  assert.deepEqual(mergeSharpRecords(m, [rec("a b c d", 100, 3), rec("e f g h", 500, 3)]), { added: 0, updated: 1, kept: 1 });
  assert.equal(m.get("e f g h")!.n, 3);
  assert.equal(m.get("a b c d")!.n, 2);
});

test("records are checked", () => {
  assert.ok(isSharpRecord({ key: "a b c d", n: 2, gap: 5, legal: 20, nodes: 1, net: "v12" }));
  assert.ok(!isSharpRecord({ key: "a b c d", n: 30, gap: 5, legal: 20, nodes: 1, net: "v12" }));
  assert.ok(!isSharpRecord({ key: "a b", n: 2, gap: 5, legal: 20, nodes: 1, net: "v12" }));
});
