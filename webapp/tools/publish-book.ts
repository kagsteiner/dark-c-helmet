// Publishes the master opening book: merges book files (from tools/seed-book.ts), writes a
// new version as master-<version>.json.gz plus manifest.json into a local folder, and with
// --upload copies that folder to the server, where the app checks for it at startup.
//
// Usage (from anywhere):
//   node webapp/tools/publish-book.ts --in ~/chess-data/seed-standard.json \
//        --in ~/chess-data/seed-960.json --dir ~/chess-data/master-book
//   ... add  --upload vps:nodejs/chess/book  to copy it to the server
//
// The upload goes in two steps so that the manifest on the server never names a missing file:
// first the new book file, then the manifest (removing older book files).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { BOOK_FILE_FORMAT, isBookEntry, shouldStore, type BookEntry } from "../src/book/book-logic.ts";
import { isManifest, MASTER_FORMAT, toMasterFile, type MasterManifest } from "../src/book/master-format.ts";

const inputs: string[] = [];
let dir = "";
let upload = "";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const [k, v] = [argv[i], argv[i + 1]];
  if (k === "--in") inputs.push(v);
  else if (k === "--dir") dir = v;
  else if (k === "--upload") upload = v;
  else throw new Error(`unknown option ${k}`);
}
if (!inputs.length || !dir) {
  console.error("usage: node webapp/tools/publish-book.ts --in FILE [--in FILE ...] --dir FOLDER [--upload HOST:PATH]");
  process.exit(2);
}

// Merge the inputs: for the same position and move the deeper search wins.
const merged = new Map<string, BookEntry>();
for (const path of inputs) {
  const file = JSON.parse(readFileSync(path, "utf8"));
  if (file.format !== BOOK_FILE_FORMAT || !Array.isArray(file.entries)) throw new Error(`${path} is not a book file`);
  let n = 0;
  for (const e of file.entries) {
    if (!isBookEntry(e)) continue;
    if (shouldStore(merged.get(e.id), e)) merged.set(e.id, e);
    n++;
  }
  console.log(`${path}: ${n.toLocaleString("en")} moves`);
}

mkdirSync(dir, { recursive: true });
const manifestPath = join(dir, "manifest.json");
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
const version = isManifest(previous) ? previous.version + 1 : 1;
const created = new Date().toISOString();

const entries = [...merged.values()];
const gz = gzipSync(JSON.stringify(toMasterFile(entries, version, created)), { level: 9 });
const fileName = `master-${version}.json.gz`;
writeFileSync(join(dir, fileName + ".tmp"), gz);
renameSync(join(dir, fileName + ".tmp"), join(dir, fileName));
for (const f of readdirSync(dir)) if (/^master-\d+\.json\.gz$/.test(f) && f !== fileName) unlinkSync(join(dir, f));

const manifest: MasterManifest = {
  format: MASTER_FORMAT,
  version,
  created,
  positions: new Set(entries.map((e) => e.key)).size,
  moves: entries.length,
  file: fileName,
  bytes: gz.length,
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Master book version ${version}: ${manifest.positions.toLocaleString("en")} positions, ` +
    `${manifest.moves.toLocaleString("en")} moves, ${(gz.length / 1e6).toFixed(2)} MB (gzip) in ${dir}`,
);

if (upload) {
  const run = (args: string[]) => {
    console.log("> rsync " + args.join(" "));
    const r = spawnSync("rsync", args, { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`rsync failed (${r.status})`);
  };
  const src = dir.endsWith("/") ? dir : dir + "/";
  const dst = upload.endsWith("/") ? upload : upload + "/";
  run(["-av", "--exclude", "manifest.json", src, dst]); // 1. the new book file
  // 2. the manifest (compared by content: an unchanged size and time stamp must not skip it);
  //    older book files go
  run(["-av", "--checksum", "--delete", src, dst]);
  console.log(`Uploaded to ${upload}`);
} else {
  console.log("Not uploaded (add --upload HOST:PATH, e.g. --upload vps:nodejs/chess/book).");
}
