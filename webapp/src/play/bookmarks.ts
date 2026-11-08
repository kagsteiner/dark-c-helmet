// Bookmarked start positions: Chess960 (white === black) and Chess 960² pairs, kept on this
// device so a start the player liked can be played again without typing numbers.
import { load, save } from "../storage.ts";

export interface Bookmark {
  white: number;
  black: number;
  /** When it was bookmarked (ms since 1970). */
  added: number;
}

const KEY = "bookmarks";

export function sameStart(a: { white: number; black: number }, b: { white: number; black: number }): boolean {
  return a.white === b.white && a.black === b.black;
}

/** "No. 104" for Chess960, "White 518 · Black 104" for Chess 960². */
export function startName(white: number, black: number): string {
  return white === black ? `No. ${white}` : `White ${white} · Black ${black}`;
}

/** Newest first. */
export async function loadBookmarks(): Promise<Bookmark[]> {
  return ((await load<Bookmark[]>(KEY)) ?? []).sort((a, b) => b.added - a.added);
}

export async function isBookmarked(white: number, black: number): Promise<boolean> {
  return (await loadBookmarks()).some((b) => sameStart(b, { white, black }));
}

/** Adds or removes the bookmark. Returns whether it is bookmarked now. */
export async function toggleBookmark(white: number, black: number): Promise<boolean> {
  const all = await loadBookmarks();
  const kept = all.filter((b) => !sameStart(b, { white, black }));
  const on = kept.length === all.length;
  if (on) kept.unshift({ white, black, added: Date.now() });
  await save(KEY, kept);
  return on;
}
