// Bookmarked start positions: Chess960 (white === black) and Chess 960² pairs, so a start the
// player liked can be played again without typing numbers. Kept on this device and, with sync on,
// on the player's other devices.
import { load, save } from "../storage.ts";
import { notifyLocalChange } from "../sync/changes.ts";

export interface Bookmark {
  white: number;
  black: number;
  /** When it was bookmarked (ms since 1970). */
  added: number;
  /** Last change (ms since 1970); the newest change wins between devices. Older ones have none. */
  changed?: number;
  /** The player's own words about this start. */
  note?: string;
  /** Removed: kept as a marker so the removal reaches the player's other devices. */
  deleted?: true;
}

const KEY = "bookmarks";

export function sameStart(a: { white: number; black: number }, b: { white: number; black: number }): boolean {
  return a.white === b.white && a.black === b.black;
}

/** "No. 104" for Chess960, "White 518 · Black 104" for Chess 960². */
export function startName(white: number, black: number): string {
  return white === black ? `No. ${white}` : `White ${white} · Black ${black}`;
}

/** E.g. "Sun, Nov 8, 2026, 8:30 AM", in the device's own format. */
export function bookmarkDate(added: number): string {
  return new Date(added).toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Everything stored, with the markers of removed bookmarks. */
export async function loadBookmarkEntries(): Promise<Bookmark[]> {
  return (await load<Bookmark[]>(KEY)) ?? [];
}

export function storeBookmarkEntries(entries: Bookmark[]): Promise<void> {
  return save(KEY, entries);
}

async function storeChanged(entries: Bookmark[]): Promise<void> {
  await save(KEY, entries);
  notifyLocalChange();
}

/** Newest first. */
export async function loadBookmarks(): Promise<Bookmark[]> {
  return (await loadBookmarkEntries()).filter((b) => !b.deleted).sort((a, b) => b.added - a.added);
}

export async function isBookmarked(white: number, black: number): Promise<boolean> {
  return (await loadBookmarks()).some((b) => sameStart(b, { white, black }));
}

/** A removed bookmark: the marker keeps only what merging needs. */
function removed(white: number, black: number, added: number): Bookmark {
  return { white, black, added, changed: Date.now(), deleted: true };
}

/** Adds or removes the bookmark. Returns whether it is bookmarked now. */
export async function toggleBookmark(white: number, black: number): Promise<boolean> {
  const all = await loadBookmarkEntries();
  const old = all.find((b) => sameStart(b, { white, black }));
  const on = !old || !!old.deleted;
  const now = Date.now();
  const entry = on ? { white, black, added: now, changed: now } : removed(white, black, old.added);
  await storeChanged([entry, ...all.filter((b) => b !== old)]);
  return on;
}

export async function setBookmarkNote(white: number, black: number, note: string): Promise<void> {
  const all = await loadBookmarkEntries();
  const mark = all.find((b) => sameStart(b, { white, black }) && !b.deleted);
  if (!mark) return;
  mark.note = note.trim() || undefined;
  mark.changed = Date.now();
  await storeChanged(all);
}

export async function removeBookmark(white: number, black: number): Promise<void> {
  const all = await loadBookmarkEntries();
  await storeChanged(all.map((b) => (sameStart(b, { white, black }) && !b.deleted ? removed(white, black, b.added) : b)));
}
