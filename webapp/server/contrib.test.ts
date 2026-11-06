import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { BOOK_FILE_FORMAT, type BookEntry } from "../src/book/book-logic.ts";
import { deviceCode, exportPublicKey, generateDeviceKey, normalizeCode, sign, verify, importPublicKey } from "../src/book/contrib.ts";
import { Api, ApiError } from "./api.ts";
import { readMaster } from "./master-write.ts";
import { publish } from "./publish.ts";
import { loadRules } from "./rules-node.ts";
import { Store } from "./store.ts";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
// Chess960-style castling rights (Shredder-FEN): White castles king side as b1h1.
const FRC = "rk5r/pppppppp/8/8/8/8/PPPPPPPP/RK5R w HAha -";
const entry = (key: string, move: string, nodes: number, source: BookEntry["source"] = "analysis"): BookEntry => ({
  id: key + " " + move,
  key,
  move,
  nodes,
  depth: 30,
  score: 20,
  net: "v12",
  build: "Dark C. Helmet 2 build 120",
  source,
  date: 0,
});

const rules = await loadRules(pathToFileURL(join(import.meta.dirname, "../public/engine/")));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "contrib-"));
  const store = new Store(join(dir, "data"));
  const api = new Api(store, rules);
  const keys = await generateDeviceKey();
  const publicKey = await exportPublicKey(keys.publicKey);
  const signed = async (body: object) => {
    const text = JSON.stringify(body);
    return [text, await sign(keys.privateKey, text)] as const;
  };
  const status = async (body: object) => api.status(...(await signed(body)));
  const submit = async (body: object) => api.submit(...(await signed(body)));
  return { dir, store, api, publicKey, status, submit, bookDir: join(dir, "book") };
}

async function rejects(p: Promise<unknown>, status: number) {
  await assert.rejects(p, (e) => e instanceof ApiError && e.status === status);
}

test("device code: 8 characters from the public key, typed forms normalized", async () => {
  const keys = await generateDeviceKey();
  const code = await deviceCode(await exportPublicKey(keys.publicKey));
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(await deviceCode(await exportPublicKey(keys.publicKey)), code);
  assert.equal(normalizeCode(code.toLowerCase().replace("-", " ")), code);
});

test("signatures: valid for the body signed, not for a changed one", async () => {
  const keys = await generateDeviceKey();
  const pub = (await importPublicKey(await exportPublicKey(keys.publicKey)))!;
  const sig = await sign(keys.privateKey, '{"device":"A"}');
  assert.equal(await verify(pub, '{"device":"A"}', sig), true);
  assert.equal(await verify(pub, '{"device":"B"}', sig), false);
  assert.equal(await importPublicKey("not a key"), null);
});

test("register, approve, submit: only approved devices, only deep and legal moves", async () => {
  const { store, api, publicKey, status, submit } = await setup();
  const reg = await api.register(JSON.stringify({ publicKey, name: "Fred's iPhone" }));
  assert.equal(reg.state, "pending");
  assert.deepEqual(await api.register(JSON.stringify({ publicKey, name: "again" })), reg); // known: same answer
  const device = reg.code;
  assert.equal((await status({ device })).state, "pending");
  await rejects(submit({ device, entries: [] }), 403);
  await rejects(api.status(JSON.stringify({ device }), "AAAA"), 401);

  const d = store.device(device)!;
  store.saveDevice({ ...d, state: "approved", user: "fred" });
  const approved = await status({ device });
  assert.equal(approved.user, "fred");
  assert.equal(approved.improvements, 0);
  assert.equal(approved.received, 0);

  const good = entry(START, "e2e4", 60e6);
  const castle = entry(FRC, "b1h1", 80e6);
  const shallow = entry(START, "d2d4", 10e6);
  const illegal = entry(START, "e2e5", 60e6);
  const seed = entry(START, "c2c4", 60e6, "seed");
  const r = await submit({ device, entries: [good, castle, shallow, illegal, seed] });
  assert.equal(r.accepted, 2);
  assert.equal(r.refused, 3);
  assert.deepEqual(r.taken.sort(), [good, castle, shallow, illegal, seed].map((e) => e.id).sort());
  assert.equal(store.log(device).length, 2);

  // Sent again: taken, not stored twice; a deeper search of the same move is stored.
  const again = await submit({ device, entries: [good, { ...good, nodes: 90e6 }] });
  assert.equal(again.accepted, 1);
  assert.equal(store.log(device).length, 3);
  assert.equal((await status({ device })).received, 2); // moves, not searches of them
  await rejects(submit({ device, entries: "x" }), 400);
});

test("publish: deeper wins, improvements counted once, revoked devices drop out", async () => {
  const { store, api, publicKey, status, submit, dir, bookDir } = await setup();
  const seed = [entry(START, "e2e4", 2.1e9, "seed"), entry(START, "d2d4", 40e6, "seed")];
  writeFileSync(join(dir, "data", "seed", "seed.json"), JSON.stringify({ format: BOOK_FILE_FORMAT, entries: seed }));
  const first = publish(store, bookDir);
  assert.equal(first.manifest.version, 1);
  assert.equal(first.manifest.moves, 2);
  assert.deepEqual(first.improvements, {});

  const device = (await api.register(JSON.stringify({ publicKey, name: "" }))).code;
  store.saveDevice({ ...store.device(device)!, state: "approved", user: "fred" });
  await submit({
    device,
    entries: [entry(START, "e2e4", 60e6), entry(START, "d2d4", 60e6), entry(START, "c2c4", 60e6)],
  });
  const second = publish(store, bookDir);
  assert.equal(second.manifest.version, 2);
  assert.deepEqual(second.improvements, { fred: 2 }); // d2d4 deeper, c2c4 new; e2e4 not deeper
  const book = new Map(readMaster(bookDir).map((e) => [e.move, e.nodes]));
  assert.deepEqual(Object.fromEntries(book), { e2e4: 2.1e9, d2d4: 60e6, c2c4: 60e6 });
  assert.equal(store.users().fred.improvements, 2);
  assert.equal((await status({ device })).improvements, 2);

  assert.deepEqual(publish(store, bookDir).improvements, {}); // nothing new: nothing counted
  assert.equal(store.users().fred.improvements, 2);

  store.saveDevice({ ...store.device(device)!, state: "revoked" });
  publish(store, bookDir);
  assert.deepEqual(readMaster(bookDir).map((e) => e.move).sort(), ["d2d4", "e2e4"]);
  assert.equal(readMaster(bookDir).find((e) => e.move === "d2d4")!.nodes, 40e6);
});
