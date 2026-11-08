// What is synced between a player's devices and how two copies combine (DESIGN.md, "Sync"). Used
// by the app and by the server. Merging gives the same result in any order, so devices can sync
// whenever they like.
import type { Bookmark } from "../play/bookmarks.ts";
import type { GameRecord } from "../play/history.ts";

export interface SyncData {
  results: GameRecord[];
  /** With the markers of deleted bookmarks, so a deletion reaches the other devices. */
  bookmarks: Bookmark[];
  /** The Fischer easter egg has been shown. */
  egg: boolean;
}

export const MAX_RESULTS = 4000;
export const MAX_BOOKMARKS = 1000;
const MAX_NOTE = 300;

/** The version of one game that got furthest: its record is rewritten while the game runs. */
function laterResult(a: GameRecord, b: GameRecord): GameRecord {
  const aDone = a.outcome !== "unfinished", bDone = b.outcome !== "unfinished";
  if (aDone !== bDone) return aDone ? a : b;
  return b.plies > a.plies ? b : a;
}

export const bookmarkChanged = (b: Bookmark): number => b.changed ?? b.added;

export function mergeData(a: SyncData, b: SyncData): SyncData {
  const results = new Map(a.results.map((r) => [r.id, r]));
  for (const r of b.results) {
    const other = results.get(r.id);
    results.set(r.id, other ? laterResult(other, r) : r);
  }
  const key = (m: Bookmark) => `${m.white}/${m.black}`;
  const bookmarks = new Map(a.bookmarks.map((m) => [key(m), m]));
  for (const m of b.bookmarks) {
    const other = bookmarks.get(key(m));
    if (!other || bookmarkChanged(m) > bookmarkChanged(other)) bookmarks.set(key(m), m);
  }
  return { results: [...results.values()], bookmarks: [...bookmarks.values()], egg: a.egg || b.egg };
}

export class InvalidData extends Error {}

const isCount = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
const isNo960 = (v: unknown): v is number => isCount(v, 959);
const isTime = (v: unknown): v is number => isCount(v, 8.64e15);

function need(ok: boolean): asserts ok {
  if (!ok) throw new InvalidData("invalid data");
}

function cleanTimeControl(v: unknown): GameRecord["tc"] {
  need(typeof v === "object" && v !== null);
  const t = v as Record<string, unknown>;
  if (t.kind === "classical") return { kind: "classical" };
  if (t.kind === "move") {
    need(typeof t.seconds === "number" && t.seconds >= 0 && t.seconds < 1e5);
    return { kind: "move", seconds: t.seconds as number };
  }
  need(t.kind === "game" && typeof t.minutes === "number" && t.minutes >= 0 && t.minutes < 1e5 && typeof t.increment === "number" && t.increment >= 0 && t.increment < 1e5);
  return { kind: "game", minutes: t.minutes as number, increment: t.increment as number };
}

function cleanResult(v: unknown): GameRecord {
  need(typeof v === "object" && v !== null);
  const r = v as Record<string, unknown>;
  need(typeof r.id === "string" && /^[a-z0-9]{1,40}$/.test(r.id));
  need(isTime(r.started) && typeof r.chess960 === "boolean" && (r.human === "w" || r.human === "b"));
  need(typeof r.opponent === "string" && /^[a-z0-9]{1,20}$/.test(r.opponent));
  need(r.outcome === "win" || r.outcome === "loss" || r.outcome === "draw" || r.outcome === "unfinished");
  need(r.star === "gold" || r.star === "silver" || r.star === null);
  need(isCount(r.plies, 100000));
  need(r.position960 === undefined || isNo960(r.position960));
  need(r.black960 === undefined || isNo960(r.black960));
  const clean: GameRecord = {
    id: r.id as string,
    started: r.started as number,
    chess960: r.chess960 as boolean,
    human: r.human as GameRecord["human"],
    opponent: r.opponent as string,
    tc: cleanTimeControl(r.tc),
    outcome: r.outcome as GameRecord["outcome"],
    star: r.star as GameRecord["star"],
    plies: r.plies as number,
  };
  if (r.position960 !== undefined) clean.position960 = r.position960 as number;
  if (r.black960 !== undefined) clean.black960 = r.black960 as number;
  return clean;
}

function cleanBookmark(v: unknown): Bookmark {
  need(typeof v === "object" && v !== null);
  const m = v as Record<string, unknown>;
  need(isNo960(m.white) && isNo960(m.black) && isTime(m.added));
  need(m.changed === undefined || isTime(m.changed));
  need(m.note === undefined || (typeof m.note === "string" && m.note.length <= MAX_NOTE));
  need(m.deleted === undefined || m.deleted === true);
  const clean: Bookmark = { white: m.white as number, black: m.black as number, added: m.added as number };
  if (m.changed !== undefined) clean.changed = m.changed as number;
  if (m.note !== undefined) clean.note = m.note as string;
  if (m.deleted) clean.deleted = true;
  return clean;
}

/** Keeps exactly the fields above; the server stores nothing else. Throws InvalidData. */
export function cleanData(v: unknown): SyncData {
  need(typeof v === "object" && v !== null);
  const d = v as Record<string, unknown>;
  need(Array.isArray(d.results) && d.results.length <= MAX_RESULTS);
  need(Array.isArray(d.bookmarks) && d.bookmarks.length <= MAX_BOOKMARKS);
  need(typeof d.egg === "boolean");
  return { results: (d.results as unknown[]).map(cleanResult), bookmarks: (d.bookmarks as unknown[]).map(cleanBookmark), egg: d.egg as boolean };
}

export const countLiveBookmarks = (data: Pick<SyncData, "bookmarks">): number => data.bookmarks.filter((m) => !m.deleted).length;
