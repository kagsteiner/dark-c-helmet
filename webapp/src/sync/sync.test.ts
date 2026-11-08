import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SyncApi } from "../../server/sync.ts";
import type { GameRecord } from "../play/history.ts";
import { completeWord, generateCode, parseCode, suggestWords } from "./code.ts";
import { cleanData, mergeData, type SyncData } from "./merge.ts";

const rec = (id: string, r: Partial<GameRecord> = {}): GameRecord => ({
  id, started: 1, chess960: true, position960: 5, human: "w", opponent: "engine",
  tc: { kind: "game", minutes: 5, increment: 0 }, outcome: "unfinished", star: "gold", plies: 10, ...r,
});
const data = (d: Partial<SyncData> = {}): SyncData => ({ results: [], bookmarks: [], egg: false, ...d });
const CODE = "famous-river-among-seven-table";
const api = (now: () => number = Date.now) => {
  const dir = mkdtempSync(join(tmpdir(), "sync-"));
  return { dir, sync: new SyncApi(dir, now) };
};
const body = (b: object) => JSON.stringify(b);

test("codes: five list words, typed loosely", () => {
  const code = generateCode();
  assert.equal(code.split("-").length, 5);
  assert.deepEqual(parseCode(code.toUpperCase().replaceAll("-", "  ")), { code });
  assert.deepEqual(parseCode("famo rive amon seve tabl"), { code: CODE });
  assert.ok("error" in parseCode("famous river among seven"));
  assert.ok("error" in parseCode("famous river among seven zzzz"));
  assert.ok("error" in parseCode("famousx river among seven table"));
});

test("codes: suggestions complete the word being typed", () => {
  assert.ok(suggestWords("river fam").includes("famous"));
  assert.equal(completeWord("river fam", "famous"), "river famous ");
});

test("merge: results from both sides, the furthest version of a game", () => {
  const m = mergeData(
    data({ results: [rec("a", { plies: 20 }), rec("b", { plies: 50 }), rec("x")] }),
    data({ results: [rec("a", { plies: 30 }), rec("b", { plies: 40, outcome: "win" }), rec("y")] }),
  );
  const by = new Map(m.results.map((r) => [r.id, r]));
  assert.equal(by.size, 4);
  assert.equal(by.get("a")!.plies, 30);
  assert.equal(by.get("b")!.outcome, "win");
});

test("merge: the newest bookmark change wins, deletions included, in either order", () => {
  const a = data({ bookmarks: [{ white: 1, black: 1, added: 5, changed: 9, deleted: true }, { white: 2, black: 2, added: 5, changed: 5 }] });
  const b = data({ bookmarks: [{ white: 1, black: 1, added: 5 }, { white: 2, black: 2, added: 5, changed: 8, note: "x" }], egg: true });
  for (const m of [mergeData(a, b), mergeData(b, a)]) {
    assert.equal(m.bookmarks.find((x) => x.white === 1)!.deleted, true);
    assert.equal(m.bookmarks.find((x) => x.white === 2)!.note, "x");
    assert.equal(m.egg, true);
  }
});

test("cleanData keeps only known fields and rejects bad ones", () => {
  const clean = cleanData(data({ results: [{ ...rec("a"), moves: "e4 e5" } as GameRecord] }));
  assert.equal("moves" in clean.results[0], false);
  assert.throws(() => cleanData(data({ results: [rec("../x")] })));
});

test("server: create, merge from a second device, peek, delete", () => {
  const { dir, sync } = api();
  sync.sync(body({ code: CODE, create: true, data: data({ results: [rec("a")] }) }));
  assert.deepEqual(sync.peek(body({ code: CODE })), { results: 1, bookmarks: 0 });
  const { data: merged } = sync.sync(body({ code: CODE, data: data({ results: [rec("b")] }) }));
  assert.equal(merged.results.length, 2);
  const [file] = readdirSync(dir);
  assert.match(file, /^[0-9a-f]{64}\.json$/);
  assert.equal(readFileSync(join(dir, file), "utf8").includes(CODE), false);
  sync.remove(body({ code: CODE }));
  assert.throws(() => sync.peek(body({ code: CODE })), { status: 404 });
  assert.throws(() => sync.sync(body({ code: CODE, data: data() })), { status: 404 }); // stays deleted
});

test("server: unknown codes are limited, known ones keep working", () => {
  let t = 1_000_000;
  const { sync } = api(() => t);
  sync.sync(body({ code: CODE, create: true, data: data() }));
  const other = "river-river-river-river-river";
  for (let i = 0; i < 30; i++) assert.throws(() => sync.peek(body({ code: other })), { status: 404 });
  assert.throws(() => sync.peek(body({ code: other })), { status: 429 });
  assert.deepEqual(sync.peek(body({ code: CODE })), { results: 0, bookmarks: 0 });
  t += 60_000;
  assert.throws(() => sync.peek(body({ code: other })), { status: 404 });
});

test("server: rejects malformed codes", () => {
  assert.throws(() => api().sync.peek(body({ code: "../../etc/passwd" })), { status: 400 });
});
