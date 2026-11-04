// The contribution server's data (DESIGN.md, "Contributions"), in plain files outside the web
// folder. One file per device, so the server (which only adds pending devices) and book-admin
// (which approves and revokes) never write the same file:
//
//   <data>/devices/<CODE>.json   a browser: public key, name, state, user
//   <data>/users.json            per user: moves that went into the master book
//   <data>/contrib/<CODE>.jsonl  what a device sent, one entry per line, append only
//   <data>/seed/*.json           seed books (book files from tools/seed-book.ts)
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BookEntry } from "../src/book/book-logic.ts";
import type { DeviceState } from "../src/book/contrib.ts";

export interface Device {
  code: string;
  publicKey: string;
  /** Typed by the person who registered it, e.g. "Fred's iPhone". */
  name: string;
  state: Exclude<DeviceState, "unknown">;
  user?: string;
  /** ISO dates */
  registered: string;
  approved?: string;
  revoked?: string;
}

export interface User {
  improvements: number;
  created: string;
}

export interface LoggedEntry extends BookEntry {
  /** ms since 1970, when the server took it */
  received: number;
}

/** Pending registrations expire after this and at most this many are kept. */
export const PENDING_DAYS = 7;
export const PENDING_MAX = 50;

export class Store {
  readonly dir: string;

  constructor(dir = process.env.CHESS_DATA ?? join(homedir(), "chess-data")) {
    this.dir = dir;
    for (const d of ["devices", "contrib", "seed"]) mkdirSync(join(dir, d), { recursive: true });
  }

  private devicePath(code: string): string {
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) throw new Error(`not a device code: ${code}`);
    return join(this.dir, "devices", code + ".json");
  }

  device(code: string): Device | null {
    try {
      return JSON.parse(readFileSync(this.devicePath(code), "utf8")) as Device;
    } catch {
      return null;
    }
  }

  devices(): Device[] {
    return readdirSync(join(this.dir, "devices"))
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        const d = this.device(f.slice(0, -5));
        return d ? [d] : [];
      });
  }

  saveDevice(d: Device): void {
    writeAtomic(this.devicePath(d.code), JSON.stringify(d, null, 2) + "\n");
  }

  /** Removes pending registrations older than PENDING_DAYS; returns the ones left. */
  pending(now = Date.now()): Device[] {
    const left: Device[] = [];
    for (const d of this.devices()) {
      if (d.state !== "pending") continue;
      if (now - Date.parse(d.registered) > PENDING_DAYS * 86400e3) unlinkSync(this.devicePath(d.code));
      else left.push(d);
    }
    return left;
  }

  users(): Record<string, User> {
    const p = join(this.dir, "users.json");
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, User>) : {};
  }

  saveUsers(users: Record<string, User>): void {
    writeAtomic(join(this.dir, "users.json"), JSON.stringify(users, null, 2) + "\n");
  }

  private logPath(code: string): string {
    return join(this.dir, "contrib", code + ".jsonl");
  }

  log(code: string): LoggedEntry[] {
    const p = this.logPath(code);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          return line ? [JSON.parse(line) as LoggedEntry] : [];
        } catch {
          return []; // a line cut short by a crash
        }
      });
  }

  append(code: string, entries: LoggedEntry[]): void {
    if (entries.length) appendFileSync(this.logPath(code), entries.map((e) => JSON.stringify(e) + "\n").join(""));
  }

  /** Paths of the seed book files. */
  seedFiles(): string[] {
    const d = join(this.dir, "seed");
    return readdirSync(d)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".state.json"))
      .sort()
      .map((f) => join(d, f));
  }
}

/** Writes via a temporary file, so a reader never sees half a file. */
export function writeAtomic(path: string, data: string | Uint8Array): void {
  writeFileSync(path + ".tmp", data);
  renameSync(path + ".tmp", path);
}
