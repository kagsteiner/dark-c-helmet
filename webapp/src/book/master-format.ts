// The master opening book: published on the server as a compact, gzip-compressed file plus a
// small manifest, built from the seed book files by tools/publish-book.ts. The app checks the
// manifest at startup and offers to merge a newer version (see book/master.ts).
import { isBookEntry, type BookEntry } from "./book-logic.ts";

export const MASTER_FORMAT = "dark-c-helmet-master-book";

/** manifest.json next to the book file. */
export interface MasterManifest {
  format: typeof MASTER_FORMAT;
  version: number;
  /** ISO date of publication */
  created: string;
  positions: number;
  moves: number;
  /** File name of the book (gzip), e.g. "master-3.json.gz", and its size in bytes. */
  file: string;
  bytes: number;
}

/** The book file (before gzip). Moves per position as [move, nodes, depth, score, net index];
 *  ids, build strings and dates are left out to keep the download small. */
export interface MasterFile {
  format: typeof MASTER_FORMAT;
  version: number;
  created: string;
  nets: string[];
  positions: Record<string, [string, number, number, number, number][]>;
}

export function toMasterFile(entries: BookEntry[], version: number, created: string): MasterFile {
  const nets: string[] = [];
  const positions: MasterFile["positions"] = {};
  for (const e of entries) {
    let net = nets.indexOf(e.net);
    if (net < 0) net = nets.push(e.net) - 1;
    (positions[e.key] ??= []).push([e.move, e.nodes, e.depth, e.score, net]);
  }
  return { format: MASTER_FORMAT, version, created, nets, positions };
}

/** Book entries of a master file; malformed parts are skipped. */
export function fromMasterFile(file: MasterFile): BookEntry[] {
  if (file?.format !== MASTER_FORMAT || typeof file.positions !== "object") throw new Error("This is not a master book file.");
  const date = Date.parse(file.created) || 0;
  const out: BookEntry[] = [];
  for (const [key, moves] of Object.entries(file.positions)) {
    if (!Array.isArray(moves)) continue;
    for (const m of moves) {
      if (!Array.isArray(m)) continue;
      const [move, nodes, depth, score, net] = m;
      const e: BookEntry = {
        id: key + " " + move,
        key,
        move,
        nodes,
        depth,
        score,
        net: file.nets[net] ?? "",
        build: "",
        source: "seed",
        date,
      };
      if (isBookEntry(e)) out.push(e);
    }
  }
  return out;
}

export function isManifest(x: unknown): x is MasterManifest {
  const m = x as MasterManifest;
  return (
    typeof m === "object" &&
    m !== null &&
    m.format === MASTER_FORMAT &&
    Number.isInteger(m.version) &&
    typeof m.file === "string" &&
    /^[\w.-]+\.json\.gz$/.test(m.file) &&
    typeof m.moves === "number" &&
    typeof m.bytes === "number"
  );
}
