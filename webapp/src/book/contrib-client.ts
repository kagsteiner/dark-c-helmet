// Sending this browser's deep searches to the master opening book (DESIGN.md, "Contributions").
// The browser has its own key pair (the private key cannot be exported); the book's maintainer
// approves its device code on the server. Entries wait in an outbox, keyed like book entries
// (a deeper result for the same move replaces the waiting one), and are sent once they have not
// changed for a while.
import { db, load, OUTBOX_STORE, request, save } from "../storage.ts";
import type { BookEntry } from "./book-logic.ts";
import {
  CONTRIB_BATCH,
  CONTRIB_MIN_NODES,
  exportPublicKey,
  generateDeviceKey,
  sign,
  SIGNATURE_HEADER,
  type DeviceState,
  type StatusReply,
  type SubmitReply,
} from "./contrib.ts";

const KEY_PAIR = "contrib-key";
const STATE = "contrib";
/** An entry is sent once it has not changed for this long (endless analysis keeps improving it). */
const SETTLE_MS = 2 * 60e3;
const INTERVAL_MS = 10 * 60e3;
const OUTBOX_MAX = 20000;
/** fetch with keepalive (page being hidden) allows 64 KB per request. */
const KEEPALIVE_BATCH = 200;

export interface ContribState {
  /** The person wants this browser to contribute. */
  enabled: boolean;
  name: string;
  /** Set once registered. */
  code?: string;
  state?: DeviceState;
  user?: string;
  improvements?: number;
  received?: number;
}

interface Queued extends BookEntry {
  /** ms since 1970: when this entry last changed */
  queued: number;
}

let current: ContribState = { enabled: false, name: "" };
let flushing = false;
let retryMs = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export function contribSupported(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof indexedDB !== "undefined";
}

export async function contribState(): Promise<ContribState> {
  // Read every time: another tab may have changed it (Settings, while Explore runs).
  current = { ...current, ...(await load<ContribState>(STATE)) };
  return current;
}

/** Called when the state or the outbox changes (the Settings screen listens). */
export function onContribChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

async function update(patch: Partial<ContribState>): Promise<void> {
  current = { ...(await contribState()), ...patch };
  await save(STATE, current);
  for (const f of listeners) f();
}

function apiUrl(path: string): string {
  return new URL("api/" + path, new URL(import.meta.env.BASE_URL, location.href)).href;
}

async function post<T>(path: string, body: string, signature?: string, keepalive = false): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers[SIGNATURE_HEADER] = signature;
  const r = await fetch(apiUrl(path), { method: "POST", headers, body, keepalive });
  const reply = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(reply.error ?? `The book server answered ${r.status}.`);
  return reply;
}

async function keyPair(): Promise<CryptoKeyPair> {
  let pair = await load<CryptoKeyPair>(KEY_PAIR);
  if (!pair) {
    pair = await generateDeviceKey();
    await save(KEY_PAIR, pair);
    if (!(await load<CryptoKeyPair>(KEY_PAIR))) throw new Error("This browser cannot store the key (private window?).");
  }
  return pair;
}

async function signed<T>(path: string, body: object, keepalive = false): Promise<T> {
  const text = JSON.stringify(body);
  return post<T>(path, text, await sign((await keyPair()).privateKey, text), keepalive);
}

function applyStatus(s: StatusReply): Promise<void> {
  return update({ code: s.code, state: s.state, user: s.user, improvements: s.improvements, received: s.received });
}

/** Turns contributing on: registers this browser (again) and returns its state. */
export async function startContributing(name: string): Promise<ContribState> {
  const publicKey = await exportPublicKey((await keyPair()).publicKey);
  await update({ enabled: true, name });
  await applyStatus(await post<StatusReply>("register", JSON.stringify({ publicKey, name })));
  scheduleFlush(1000);
  return current;
}

export async function stopContributing(): Promise<void> {
  await update({ enabled: false });
}

/** Asks the server for this browser's state (pending, approved, revoked). */
export async function refreshContribStatus(): Promise<ContribState> {
  const s = await contribState();
  if (!s.code) return s;
  try {
    await applyStatus(await signed<StatusReply>("status", { device: s.code }));
  } catch (err) {
    if (err instanceof Error && /unknown device/.test(err.message)) await update({ state: "unknown" }); // expired
    else throw err;
  }
  if (current.state === "revoked") await clearOutbox();
  return current;
}

/** A search this browser's engine just stored in its book: send it if it is deep enough. */
export async function offerEntry(entry: BookEntry): Promise<void> {
  if (entry.nodes < CONTRIB_MIN_NODES || entry.source === "seed") return;
  const s = await contribState();
  if (!s.enabled || s.state === "revoked") return;
  try {
    await request(OUTBOX_STORE, "readwrite", (o) => o.put({ ...entry, queued: Date.now() } satisfies Queued));
    const n = await outboxCount();
    if (n > OUTBOX_MAX) await removeFromOutbox((await allQueued()).sort((a, b) => a.queued - b.queued).slice(0, n - OUTBOX_MAX).map((e) => e.id));
  } catch {
    return; // storage unavailable
  }
  for (const f of listeners) f();
  scheduleFlush(SETTLE_MS + 5000);
}

export function outboxCount(): Promise<number> {
  return request<number>(OUTBOX_STORE, "readonly", (o) => o.count()).catch(() => 0);
}

function allQueued(): Promise<Queued[]> {
  return request<Queued[]>(OUTBOX_STORE, "readonly", (o) => o.getAll());
}

async function removeFromOutbox(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(OUTBOX_STORE, "readwrite");
    const o = tx.objectStore(OUTBOX_STORE);
    for (const id of ids) o.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearOutbox(): Promise<void> {
  await request(OUTBOX_STORE, "readwrite", (o) => o.clear()).catch(() => {});
}

function scheduleFlush(ms: number): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    flush();
  }, ms);
}

/** Sends the settled entries of the outbox. `keepalive`: the page is being hidden (one batch). */
export async function flush(keepalive = false): Promise<void> {
  const s = await contribState();
  if (!s.enabled || !s.code || flushing || !contribSupported()) return;
  flushing = true;
  try {
    if (s.state !== "approved" && !keepalive) await refreshContribStatus();
    if (current.state !== "approved") return;
    let accepted = 0;
    for (;;) {
      const now = Date.now();
      const settled = (await allQueued()).filter((e) => now - e.queued >= SETTLE_MS).sort((a, b) => a.queued - b.queued);
      if (!settled.length) break;
      const batch = settled.slice(0, keepalive ? KEEPALIVE_BATCH : CONTRIB_BATCH).map(({ queued: _, ...e }) => e);
      const reply = await signed<SubmitReply>("submit", { device: current.code, entries: batch }, keepalive);
      // An entry that changed while it was on its way stays: it is a deeper search.
      const sentNodes = new Map(batch.map((e) => [e.id, e.nodes]));
      const still = new Map((await allQueued()).map((e) => [e.id, e.nodes]));
      await removeFromOutbox(reply.taken.filter((id) => still.get(id) === sentNodes.get(id)));
      for (const f of listeners) f();
      retryMs = 0;
      accepted += reply.accepted;
      if (reply.limited || keepalive || !reply.taken.length) break;
    }
    if (accepted && !keepalive) await refreshContribStatus(); // the server's counts have changed
  } catch (err) {
    if (err instanceof Error && /revoked/.test(err.message)) await refreshContribStatus().catch(() => {});
    retryMs = Math.min(Math.max(60e3, retryMs * 2), 3600e3);
    if (!keepalive) scheduleFlush(retryMs);
  } finally {
    flushing = false;
  }
}

/** At startup: send what is waiting, then every 10 minutes, when the page is hidden and when
 *  the device comes back online. */
export function startContributions(): void {
  if (!contribSupported()) return;
  scheduleFlush(10e3);
  setInterval(() => flush(), INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
  window.addEventListener("online", () => flush());
}
