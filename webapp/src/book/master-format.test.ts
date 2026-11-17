import assert from "node:assert/strict";
import { test } from "node:test";
import type { BookEntry } from "./book-logic.ts";
import { fromMasterFile, isManifest, sharpnessFromMasterFile, toMasterFile, MASTER_FORMAT } from "./master-format.ts";
import type { SharpRecord } from "./sharpness.ts";

const KEY = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
const entry = (move: string, nodes: number, net: string): BookEntry => ({
  id: KEY + " " + move,
  key: KEY,
  move,
  nodes,
  depth: 30,
  score: 20,
  net,
  build: "Dark C. Helmet 2 build 95",
  source: "seed",
  date: 0,
});

test("round trip keeps position, move, nodes, depth, score, net", () => {
  const entries = [entry("e2e4", 5e7, "v11"), entry("d2d4", 6e7, "v12")];
  const file = toMasterFile(entries, 3, "2026-11-01T00:00:00.000Z");
  assert.deepEqual(file.nets, ["v11", "v12"]);
  const back = fromMasterFile(JSON.parse(JSON.stringify(file)));
  assert.deepEqual(
    back.map((e) => [e.id, e.nodes, e.depth, e.score, e.net, e.source]),
    entries.map((e) => [e.id, e.nodes, e.depth, e.score, e.net, "seed"]),
  );
});

test("malformed moves are skipped, wrong files rejected", () => {
  const file = toMasterFile([entry("e2e4", 1, "v11")], 1, "2026-11-01T00:00:00.000Z");
  file.positions[KEY].push(["zz", 1, 1, 1, 0]);
  assert.equal(fromMasterFile(file).length, 1);
  assert.throws(() => fromMasterFile({ format: "x" } as never));
});

test("manifest check", () => {
  const m = { format: MASTER_FORMAT, version: 2, created: "", positions: 1, moves: 1, file: "master-2.json.gz", bytes: 10 };
  assert.equal(isManifest(m), true);
  assert.equal(isManifest({ ...m, file: "../../etc/passwd" }), false);
});

test("sharpness travels with the master book and is optional", () => {
  const recs: SharpRecord[] = [
    { key: KEY, n: 2, gap: 40, legal: 20, nodes: 500000, net: "v12" },
    { key: KEY.replace(" w ", " b "), n: 1, gap: 250, legal: 3, nodes: 500000, net: "v11" },
  ];
  const file = toMasterFile([entry("e2e4", 1, "v11")], 1, "2026-11-01T00:00:00.000Z", recs);
  assert.deepEqual(sharpnessFromMasterFile(JSON.parse(JSON.stringify(file))), recs);
  // a file without the section (older versions) has none
  assert.deepEqual(sharpnessFromMasterFile(toMasterFile([entry("e2e4", 1, "v11")], 1, "")), []);
  // malformed records are skipped
  file.sharpness![KEY] = [99, 0, 20, 1, 0];
  assert.equal(sharpnessFromMasterFile(file).length, 1);
});
