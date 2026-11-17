// Sync of results and bookmarks between a player's devices (DESIGN.md, "Sync"): one file per code,
// named by a hash of the code. There are no accounts and no IP addresses here, so the limits
// against guessing and filling the disk are global. All file access is synchronous, so a merge
// cannot interleave with another one.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODE_WORDS } from "../src/sync/code.ts";
import { cleanData, countLiveBookmarks, InvalidData, MAX_BOOKMARKS, MAX_RESULTS, mergeData, type SyncData } from "../src/sync/merge.ts";
import { ApiError } from "./api.ts";

const CODE = new RegExp(`^[a-z]{3,8}(-[a-z]{3,8}){${CODE_WORDS - 1}}$`);
// Global backstops: nginx limits each client address (deploy/limits.conf); these only bound what
// many addresses together can do. Every global limit can be used up by an attacker, so they are
// set well above normal use, and the disk limit is in bytes, not in codes.
const MAX_CODES = 20_000;
/** All sync files together (bytes): a full code is about 1.5 MB. */
const MAX_BYTES = 2 * 1024 ** 3;
/** Lookups of codes that do not exist, per minute (55-bit codes: guessing stays hopeless). */
export const MAX_MISSES = 120;
/** New codes per hour. */
export const MAX_CREATES = 120;

/** At most `max` events per `ms`. */
class Limit {
  private since = 0;
  private count = 0;
  private max: number;
  private ms: number;
  private now: () => number;
  constructor(max: number, ms: number, now: () => number) {
    this.max = max;
    this.ms = ms;
    this.now = now;
  }
  private roll(): void {
    if (this.now() - this.since >= this.ms) {
      this.since = this.now();
      this.count = 0;
    }
  }
  reached(): boolean {
    this.roll();
    return this.count >= this.max;
  }
  add(): void {
    this.roll();
    this.count++;
  }
}

export class SyncApi {
  private dir: string;
  private codes: number;
  private bytes = 0;
  private misses: Limit;
  private creates: Limit;

  constructor(dir?: string, now: () => number = Date.now) {
    this.dir = dir ?? join(process.env.CHESS_DATA ?? join(homedir(), "chess-data"), "sync");
    mkdirSync(this.dir, { recursive: true });
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    this.codes = files.length;
    for (const f of files) this.bytes += statSync(join(this.dir, f)).size;
    this.misses = new Limit(MAX_MISSES, 60_000, now);
    this.creates = new Limit(MAX_CREATES, 3_600_000, now);
  }

  private file(code: string): string {
    return join(this.dir, createHash("sha256").update(code).digest("hex") + ".json");
  }

  private parse(body: string): { code: string; create: boolean; data: unknown; file: string } {
    let v: { code?: unknown; create?: unknown; data?: unknown };
    try {
      v = JSON.parse(body);
    } catch {
      throw new ApiError(400, "invalid request");
    }
    if (typeof v?.code !== "string" || !CODE.test(v.code)) throw new ApiError(400, "invalid code");
    return { code: v.code, create: v.create === true, data: v.data, file: this.file(v.code) };
  }

  private missing(): never {
    if (this.misses.reached()) throw new ApiError(429, "too many attempts, try again in a minute");
    this.misses.add();
    throw new ApiError(404, "no data under this code");
  }

  private read(file: string): SyncData {
    return JSON.parse(readFileSync(file, "utf8")) as SyncData;
  }

  /** How much is stored under a code, shown before a device is linked to it. */
  peek(body: string): { results: number; bookmarks: number } {
    const { file } = this.parse(body);
    if (!existsSync(file)) this.missing();
    const data = this.read(file);
    return { results: data.results.length, bookmarks: countLiveBookmarks(data) };
  }

  /** Merges what a device sent into what is stored and returns the result. A new code only
   *  with `allowCreate` (its own endpoint, /sync/create, so nginx can limit it per address). */
  sync(body: string, allowCreate = false): { data: SyncData } {
    const { create: wants, data, file } = this.parse(body);
    if (wants && !allowCreate && !existsSync(file)) throw new ApiError(400, "please reload the app to create a code");
    const create = allowCreate;
    let sent: SyncData;
    try {
      sent = cleanData(data);
    } catch (err) {
      if (err instanceof InvalidData) throw new ApiError(400, err.message);
      throw err;
    }
    const known = existsSync(file);
    if (!known && !create) this.missing();
    if (!known) {
      if (this.codes >= MAX_CODES || this.creates.reached()) throw new ApiError(429, "no new codes possible right now, try again later");
      this.creates.add();
    }
    const merged = known ? mergeData(this.read(file), sent) : sent;
    if (merged.results.length > MAX_RESULTS || merged.bookmarks.length > MAX_BOOKMARKS) throw new ApiError(413, "the storage for this code is full");
    const text = JSON.stringify(merged);
    const size = Buffer.byteLength(text);
    const old = known ? statSync(file).size : 0;
    if (size > old && this.bytes + size - old > MAX_BYTES) throw new ApiError(507, "the sync storage is full right now, try again later");
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    this.bytes += size - old;
    if (!known) this.codes++;
    return { data: merged };
  }

  remove(body: string): { deleted: true } {
    const { file } = this.parse(body);
    if (!existsSync(file)) this.missing();
    this.bytes -= statSync(file).size;
    unlinkSync(file);
    this.codes--;
    return { deleted: true };
  }
}
