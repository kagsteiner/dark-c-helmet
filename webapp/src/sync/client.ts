// Sync between a player's devices (DESIGN.md, "Sync"). Off until the player turns it on. The
// server merges; this module sends what the device has and stores what comes back.
import { loadBookmarkEntries, storeBookmarkEntries } from "../play/bookmarks.ts";
import { loadRecords, storeRecords } from "../play/history.ts";
import { settings, updateSettings } from "../settings.ts";
import { load, save } from "../storage.ts";
import { EGG_KEY, onLocalChange } from "./changes.ts";
import { generateCode } from "./code.ts";
import { countLiveBookmarks, mergeData, type SyncData } from "./merge.ts";

export interface SyncState {
  code: string | null;
  /** Last successful sync (ms since 1970). */
  last?: number;
  /** Sync was turned off because the code's data was deleted from the server. */
  deletedElsewhere?: boolean;
}

export interface Counts {
  results: number;
  bookmarks: number;
}

export class SyncError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const STATE_KEY = "sync";
const AFTER_CHANGE_MS = 2000;
const WHEN_VISIBLE_MS = 60_000;

let state: SyncState = { code: null };
const listeners = new Set<() => void>();

async function setState(next: SyncState): Promise<void> {
  state = next;
  await save(STATE_KEY, state);
  for (const l of listeners) l();
}

export function syncState(): SyncState {
  return state;
}

export function onSyncChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const url = new URL("api/" + path, new URL(import.meta.env.BASE_URL, location.href)).href;
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new SyncError("The server cannot be reached right now.", 0);
  }
  const value = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new SyncError(value.error ?? "The server reported an error.", r.status);
  return value;
}

async function readLocal(): Promise<SyncData> {
  const data: SyncData = { results: await loadRecords(), bookmarks: await loadBookmarkEntries(), egg: !!(await load<boolean>(EGG_KEY)) };
  const s = settings();
  if (s.boardChanged) data.board = { theme: s.boardTheme, color: s.boardColor, changed: s.boardChanged };
  return data;
}

export async function localCounts(): Promise<Counts> {
  const local = await readLocal();
  return { results: local.results.length, bookmarks: countLiveBookmarks(local) };
}

/** Sends this device's data and stores the merged data. Merges with the device once more, in
 *  case something changed while the request was under way. */
async function exchange(code: string, create: boolean): Promise<void> {
  const { data } = await post<{ data: SyncData }>("sync", { code, create, data: await readLocal() });
  const local = await readLocal();
  const merged = mergeData(local, data);
  const before = new Map(local.results.map((r) => [r.id, r]));
  await storeRecords(merged.results.filter((r) => r !== before.get(r.id)));
  await storeBookmarkEntries(merged.bookmarks);
  if (merged.egg && !local.egg) await save(EGG_KEY, true);
  const b = merged.board;
  if (b && b.changed > (local.board?.changed ?? 0)) updateSettings({ boardTheme: b.theme, boardColor: b.color, boardChanged: b.changed });
}

/** Turns sync on with a new code. */
export async function createSyncCode(): Promise<void> {
  const code = generateCode();
  await exchange(code, true);
  await setState({ code, last: Date.now() });
}

/** What is stored under a code; rejects with status 404 when there is nothing. */
export function peekCode(code: string): Promise<Counts> {
  return post<Counts>("sync/peek", { code });
}

export async function linkDevice(code: string): Promise<void> {
  await exchange(code, false);
  await setState({ code, last: Date.now() });
}

let running: Promise<void> | null = null;
let again = false;

/** Syncs now, or once more after a sync that is under way. */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        const code = state.code;
        if (!code) return;
        try {
          await exchange(code, false);
        } catch (err) {
          if (err instanceof SyncError && err.status === 404) return await setState({ code: null, deletedElsewhere: true });
          throw err;
        }
        await setState({ code, last: Date.now() });
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Stops syncing on this device. What is on the server and on this device stays. */
export function stopSync(): Promise<void> {
  return setState({ code: null });
}

/** Deletes the code's data from the server; the other devices stop syncing at their next sync. */
export async function deleteSyncData(): Promise<void> {
  if (state.code) await post("sync/delete", { code: state.code });
  await setState({ code: null });
}

/** Background sync failures wait for the next chance; the Settings screen reports its own. */
const quietly = () => void syncNow().catch(() => {});

export async function startSync(): Promise<void> {
  state = { ...state, ...(await load<SyncState>(STATE_KEY)) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  onLocalChange(() => {
    if (!state.code) return;
    clearTimeout(timer);
    timer = setTimeout(quietly, AFTER_CHANGE_MS);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.code && Date.now() - (state.last ?? 0) > WHEN_VISIBLE_MS) quietly();
  });
  if (state.code) quietly();
}
