// book-admin publish: rebuilds the master book from all inputs (seed books and the logs of
// approved devices) and counts, per user, the moves that went into it.
import { readFileSync } from "node:fs";
import { BOOK_FILE_FORMAT, isBookEntry, shouldStore, type BookEntry } from "../src/book/book-logic.ts";
import type { MasterManifest } from "../src/book/master-format.ts";
import { readMaster, writeMaster } from "./master-write.ts";
import type { Store } from "./store.ts";

export interface PublishResult {
  manifest: MasterManifest;
  seedMoves: number;
  contributed: number;
  /** Per user: moves new in the book or deeper than before, this time. */
  improvements: Record<string, number>;
}

export function publish(store: Store, bookDir: string): PublishResult {
  // For the same position and move the deeper search wins; with equal nodes the earlier one
  // (seed books first, then contributions in the order the server took them).
  const merged = new Map<string, { entry: BookEntry; user: string | null }>();
  let seedMoves = 0;
  for (const path of store.seedFiles()) {
    const file = JSON.parse(readFileSync(path, "utf8"));
    if (file.format !== BOOK_FILE_FORMAT || !Array.isArray(file.entries)) throw new Error(`${path} is not a book file`);
    for (const e of file.entries) {
      if (!isBookEntry(e)) continue;
      seedMoves++;
      if (shouldStore(merged.get(e.id)?.entry, e)) merged.set(e.id, { entry: e, user: null });
    }
  }
  const contributions = store
    .devices()
    .filter((d) => d.state === "approved" && d.user)
    .flatMap((d) => store.log(d.code).map((e) => ({ e, user: d.user! })))
    .sort((a, b) => a.e.received - b.e.received);
  for (const { e, user } of contributions) {
    const { received: _, ...entry } = e;
    if (shouldStore(merged.get(e.id)?.entry, entry)) merged.set(e.id, { entry, user });
  }

  // An entry counts for its user when it is new in the master book or deeper than before.
  const before = new Map(readMaster(bookDir).map((e) => [e.id, e.nodes]));
  const improvements: Record<string, number> = {};
  for (const { entry, user } of merged.values())
    if (user && (before.get(entry.id) ?? 0) < entry.nodes) improvements[user] = (improvements[user] ?? 0) + 1;

  const manifest = writeMaster(bookDir, [...merged.values()].map((m) => m.entry));
  const users = store.users();
  for (const [user, n] of Object.entries(improvements)) {
    users[user] ??= { improvements: 0, created: new Date().toISOString() };
    users[user].improvements += n;
  }
  store.saveUsers(users);
  return { manifest, seedMoves, contributed: contributions.length, improvements };
}
