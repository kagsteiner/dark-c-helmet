// Sharpness files (tools/book-sharpness.ts) and how they join the master book: the records of
// the published version stay, files add to them, and for a position the record measured with
// more nodes wins.
import { readFileSync } from "node:fs";
import { isSharpRecord, mergeSharpRecords, SHARP_FILE_FORMAT, type SharpRecord } from "../src/book/sharpness.ts";

export function readSharpnessFile(path: string): SharpRecord[] {
  const file = JSON.parse(readFileSync(path, "utf8"));
  if (file.format !== SHARP_FILE_FORMAT || !Array.isArray(file.records)) throw new Error(`${path} is not a sharpness file`);
  return file.records.filter(isSharpRecord);
}

/** The published records plus those of the files. */
export function mergeSharpnessFiles(published: SharpRecord[], paths: string[]): SharpRecord[] {
  const merged = new Map(published.map((r) => [r.key, r]));
  for (const p of paths) mergeSharpRecords(merged, readSharpnessFile(p));
  return [...merged.values()];
}
