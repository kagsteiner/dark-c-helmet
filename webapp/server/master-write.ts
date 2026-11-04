// Writing a new master book version into a folder: master-<version>.json.gz, then manifest.json.
// Used by book-admin publish on the VPS and by tools/publish-book.ts on the Mac.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { BookEntry } from "../src/book/book-logic.ts";
import { fromMasterFile, isManifest, MASTER_FORMAT, toMasterFile, type MasterManifest } from "../src/book/master-format.ts";
import { writeAtomic } from "./store.ts";

export function readManifest(dir: string): MasterManifest | null {
  const p = join(dir, "manifest.json");
  if (!existsSync(p)) return null;
  const m: unknown = JSON.parse(readFileSync(p, "utf8"));
  return isManifest(m) ? m : null;
}

/** The entries of the version the manifest names (empty if there is none). */
export function readMaster(dir: string): BookEntry[] {
  const m = readManifest(dir);
  if (!m || !existsSync(join(dir, m.file))) return [];
  return fromMasterFile(JSON.parse(gunzipSync(readFileSync(join(dir, m.file))).toString("utf8")));
}

/** Writes the next version. The book file comes first, the manifest second, so the manifest
 *  never names a missing file; the previous version's file is kept for apps that just read the
 *  old manifest, older ones go. */
export function writeMaster(dir: string, entries: BookEntry[]): MasterManifest {
  mkdirSync(dir, { recursive: true });
  const previous = readManifest(dir);
  const version = (previous?.version ?? 0) + 1;
  const created = new Date().toISOString();
  const gz = gzipSync(JSON.stringify(toMasterFile(entries, version, created)), { level: 9 });
  const file = `master-${version}.json.gz`;
  writeAtomic(join(dir, file), gz);
  const manifest: MasterManifest = {
    format: MASTER_FORMAT,
    version,
    created,
    positions: new Set(entries.map((e) => e.key)).size,
    moves: entries.length,
    file,
    bytes: gz.length,
  };
  writeAtomic(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const f of readdirSync(dir)) if (/^master-\d+\.json\.gz$/.test(f) && f !== file && f !== previous?.file) unlinkSync(join(dir, f));
  return manifest;
}
