// The contribution endpoints without HTTP (tested in Node): register, status, submit.
// Only cheap checks; nothing is searched again (DESIGN.md, "Contributions").
import type { Rules } from "../src/chess/rules.ts";
import { bookMoveName, isBookEntry, type BookEntry } from "../src/book/book-logic.ts";
import {
  CONTRIB_BATCH,
  CONTRIB_DAILY_LIMIT,
  CONTRIB_MIN_NODES,
  deviceCode,
  importPublicKey,
  verify,
  type RegisterRequest,
  type SignedBody,
  type StatusReply,
  type SubmitReply,
} from "../src/book/contrib.ts";
import { PENDING_MAX, type Device, type LoggedEntry, type Store } from "./store.ts";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Api {
  private store: Store;
  private rules: Rules;
  /** Per device: the node count it already sent for each id (read from its log on first use). */
  private sent = new Map<string, Map<string, number>>();
  /** Entries taken per user and UTC day ("fred 2026-11-04"). */
  private today = new Map<string, number>();

  constructor(store: Store, rules: Rules) {
    this.store = store;
    this.rules = rules;
  }

  async register(body: string): Promise<StatusReply> {
    const req = parse<RegisterRequest>(body);
    if (typeof req.publicKey !== "string" || !(await importPublicKey(req.publicKey))) throw new ApiError(400, "not a public key");
    const code = await deviceCode(req.publicKey);
    const known = this.store.device(code);
    if (known) return this.reply(known);
    if (this.store.pending().length >= PENDING_MAX) throw new ApiError(503, "too many registrations are waiting; try again later");
    const name = typeof req.name === "string" ? req.name.trim().slice(0, 60) : "";
    const device: Device = { code, publicKey: req.publicKey, name, state: "pending", registered: new Date().toISOString() };
    this.store.saveDevice(device);
    return this.reply(device);
  }

  async status(body: string, signature: string): Promise<StatusReply> {
    const { device } = await this.authenticate(body, signature);
    return this.reply(device);
  }

  async submit(body: string, signature: string, now = Date.now()): Promise<SubmitReply> {
    const { device, req } = await this.authenticate(body, signature);
    if (device.state !== "approved" || !device.user) throw new ApiError(403, `this device is ${device.state}`);
    if (!Array.isArray(req.entries) || req.entries.length > CONTRIB_BATCH) throw new ApiError(400, `entries: a list of at most ${CONTRIB_BATCH}`);
    const sent = this.sentBy(device.code);
    const day = device.user + " " + new Date(now).toISOString().slice(0, 10);
    let count = this.today.get(day) ?? 0;
    const reply: SubmitReply = { taken: [], accepted: 0, refused: 0, limited: false };
    const fresh: LoggedEntry[] = [];
    for (const e of req.entries) {
      if (!this.valid(e)) {
        if (typeof (e as BookEntry)?.id === "string") reply.taken.push((e as BookEntry).id);
        reply.refused++;
        continue;
      }
      if ((sent.get(e.id) ?? 0) >= e.nodes) {
        reply.taken.push(e.id); // sent before
        continue;
      }
      if (count >= CONTRIB_DAILY_LIMIT) {
        reply.limited = true;
        continue;
      }
      count++;
      sent.set(e.id, e.nodes);
      fresh.push({
        id: e.id,
        key: e.key,
        move: e.move,
        nodes: e.nodes,
        depth: e.depth,
        score: e.score,
        net: e.net,
        build: e.build,
        source: e.source,
        date: e.date,
        received: now,
      });
      reply.taken.push(e.id);
      reply.accepted++;
    }
    this.store.append(device.code, fresh);
    this.today.set(day, count);
    return reply;
  }

  /** The device that signed this body; the signature must match its public key. */
  private async authenticate(body: string, signature: string): Promise<{ device: Device; req: Partial<SignedBody> }> {
    const req = parse<SignedBody>(body);
    const device = typeof req.device === "string" && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(req.device) ? this.store.device(req.device) : null;
    if (!device) throw new ApiError(404, "unknown device");
    const key = await importPublicKey(device.publicKey);
    if (!key || !(await verify(key, body, signature))) throw new ApiError(401, "bad signature");
    return { device, req };
  }

  private reply(d: Device): StatusReply {
    const r: StatusReply = { code: d.code, state: d.state };
    if (d.state === "approved" && d.user) {
      r.user = d.user;
      r.improvements = this.store.users()[d.user]?.improvements ?? 0;
    }
    return r;
  }

  private sentBy(code: string): Map<string, number> {
    let m = this.sent.get(code);
    if (!m) {
      m = new Map();
      for (const e of this.store.log(code)) m.set(e.id, Math.max(m.get(e.id) ?? 0, e.nodes));
      this.sent.set(code, m);
    }
    return m;
  }

  /** Format, depth of the search, and a legal move in that position. */
  private valid(x: unknown): x is BookEntry {
    if (!isBookEntry(x)) return false;
    const e = x as BookEntry;
    const short = (s: unknown) => typeof s === "string" && s.length <= 100;
    if (
      e.nodes < CONTRIB_MIN_NODES ||
      !Number.isFinite(e.nodes) ||
      !Number.isInteger(e.depth) ||
      !Number.isInteger(e.score) ||
      Math.abs(e.score) > 10000 ||
      !short(e.net) ||
      !short(e.build) ||
      (e.source !== "game" && e.source !== "analysis") ||
      typeof e.date !== "number"
    )
      return false;
    // Chess960 mode reads both castling notations; book moves castle as king takes rook.
    if (!this.rules.setFen(e.key + " 0 1", true)) return false;
    return this.rules.moves().some((m) => bookMoveName(m) === e.move);
  }
}

function parse<T>(body: string): Partial<T> {
  try {
    const v: unknown = JSON.parse(body);
    if (typeof v === "object" && v !== null) return v as Partial<T>;
  } catch {
    // falls through
  }
  throw new ApiError(400, "not JSON");
}
