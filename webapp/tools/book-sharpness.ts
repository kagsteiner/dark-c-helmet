// Sharpness for the opening book, offline: for every position of the book (and every position
// a book move leads to) the native engine searches each legal move with a fixed node count;
// the scores give n and gap (src/book/sharpness.ts). Resumable and incremental: positions
// that already have a record of at least the wanted quality are skipped, so after the first
// long run, a run after new book contributions only measures the new positions.
//
// Usage (from webapp/, after `npm run engine`):
//   node tools/book-sharpness.ts --out ~/chess-data/sharpness.json
//   node tools/book-sharpness.ts --out ~/chess-data/sharpness.json --dry-run       (count, estimate)
//   node tools/book-sharpness.ts --out ~/chess-data/sharpness.json --limit 200     (sample run)
// Then publish: node tools/publish-book.ts ... --sharp ~/chess-data/sharpness.json, or copy the
// file to <data>/sharpness/ on the server and run book-admin publish.
//
// Options:
//   --out FILE           sharpness file (read first if it exists, so a run resumes)
//   --book SRC           where the positions come from: a book file, a master book (.json.gz)
//                        or a URL of the master manifest (default https://darkhelmet.eu/book/manifest.json).
//                        A master book's own sharpness counts as already measured.
//   --probe-nodes N      nodes per legal move (default 1000000)
//   --workers N          engine processes (default: logical cores - 1)
//   --hash MB            hash per engine process (default 64)
//   --engine PATH        native engine (default ../bin/darkhelmet)
//   --hours H            stop by itself after H hours (like Ctrl-C once)
//   --limit N            measure at most N positions in this run
//   --refresh-other-nets measure again the positions whose record is from another net
//   --all                also positions that no book move chain from the start position reaches
//                        (default: only the standard opening tree)
//   --dry-run            count the positions and estimate the time, then stop
// Ctrl-C once: finish the running positions, save, stop. Twice: save and stop at once.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { BOOK_FILE_FORMAT, bookKey, bookMoveName, bookScore, isBookEntry, type BookEntry } from "../src/book/book-logic.ts";
import { fromMasterFile, isManifest, MASTER_FORMAT, sharpnessFromMasterFile, type MasterFile } from "../src/book/master-format.ts";
import { computeSharpness, isSharpRecord, mergeSharpRecords, SHARP_FILE_FORMAT, type SharpRecord } from "../src/book/sharpness.ts";
import { Game, START_FEN } from "../src/chess/game.ts";
import { Rules } from "../src/chess/rules.ts";

// --- options --------------------------------------------------------------------------------

const FLAGS = new Set(["refresh-other-nets", "all", "dry-run"]);
const args = new Map<string, string>();
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    const k = argv[i].slice(2);
    if (FLAGS.has(k)) args.set(k, "1");
    else args.set(k, argv[++i] ?? "");
  }
}
const out = args.get("out");
if (!out) {
  console.error("usage: node tools/book-sharpness.ts --out FILE [options] (see the comment at the top of this file)");
  process.exit(2);
}
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const opts = {
  book: args.get("book") ?? "https://darkhelmet.eu/book/manifest.json",
  probeNodes: num("probe-nodes", 1_000_000),
  workers: num("workers", Math.max(1, availableParallelism() - 1)),
  hash: num("hash", 64),
  engine: args.get("engine") ?? fileURLToPath(new URL("../../bin/darkhelmet", import.meta.url)),
  hours: num("hours", 0),
  limit: num("limit", 0),
  refreshOtherNets: args.has("refresh-other-nets"),
  all: args.has("all"),
  dryRun: args.has("dry-run"),
};

// --- reading the book -----------------------------------------------------------------------

interface BookSource {
  entries: BookEntry[];
  sharpness: SharpRecord[];
}

function fromText(text: string, label: string): BookSource {
  const file = JSON.parse(text);
  if (file.format === MASTER_FORMAT) return { entries: fromMasterFile(file as MasterFile), sharpness: sharpnessFromMasterFile(file as MasterFile) };
  if (file.format === BOOK_FILE_FORMAT && Array.isArray(file.entries)) return { entries: file.entries.filter(isBookEntry), sharpness: [] };
  throw new Error(`${label} is neither a book file nor a master book`);
}

function unpack(bytes: Uint8Array): string {
  const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return (gz ? gunzipSync(bytes) : Buffer.from(bytes)).toString("utf8");
}

async function readBook(src: string): Promise<BookSource> {
  if (/^https?:\/\//.test(src)) {
    const m: unknown = await (await fetch(src, { cache: "no-cache" })).json();
    if (!isManifest(m)) throw new Error(`${src} is not a master book manifest`);
    const url = new URL(m.file, src).href;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    console.log(`Master book version ${m.version} from ${url}`);
    return fromText(unpack(new Uint8Array(await r.arrayBuffer())), url);
  }
  return fromText(unpack(readFileSync(src)), src);
}

// --- engine ---------------------------------------------------------------------------------

let stopping = false;
let finished = false;

class UciEngine {
  net = "";
  private proc: ChildProcessWithoutNullStreams;
  private waiting: { prefix: string; resolve: (line: string) => void } | null = null;
  private score = 0;

  constructor(path: string) {
    // Own process group: Ctrl-C reaches only this script, which lets running searches finish.
    this.proc = spawn(path, [], { stdio: "pipe", detached: true });
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    this.proc.on("exit", (code) => {
      if (!stopping && !finished) console.error(`engine process exited (${code})`);
    });
  }

  private onLine(line: string): void {
    const t = line.split(/\s+/);
    if (line.startsWith("info string net ")) this.net = line.slice(16);
    else if (t[0] === "info" && t.includes("score") && t.includes("pv")) {
      const s = t.indexOf("score");
      this.score = bookScore(t[s + 1] === "mate" ? { mate: Number(t[s + 2]) } : { cp: Number(t[s + 2]) });
    }
    if (this.waiting && line.startsWith(this.waiting.prefix)) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve(line);
    }
  }

  private send(cmd: string): void {
    this.proc.stdin.write(cmd + "\n");
  }

  private waitFor(prefix: string): Promise<string> {
    return new Promise((resolve) => (this.waiting = { prefix, resolve }));
  }

  async init(): Promise<void> {
    this.send("uci");
    await this.waitFor("uciok");
    this.send("setoption name Threads value 1");
    this.send(`setoption name Hash value ${opts.hash}`);
    this.send("setoption name UCI_Chess960 value true"); // castling as king takes rook, as in the book
    this.send("isready");
    await this.waitFor("readyok");
  }

  /** Score (side to move at the end of `moves`) of a search of the position. */
  async search(fen: string, moves: string[], nodes: number): Promise<number> {
    this.score = 0;
    this.send(`position fen ${fen}${moves.length ? " moves " + moves.join(" ") : ""}`);
    this.send(`go nodes ${nodes}`);
    await this.waitFor("bestmove");
    return this.score;
  }

  quit(): void {
    this.send("quit");
  }
}

// --- the positions ----------------------------------------------------------------------------

const rules = await Rules.load(
  new URL("../public/engine/", import.meta.url).href,
  readFileSync(new URL("../public/engine/dh-rules.wasm", import.meta.url)),
);

interface Task {
  key: string;
  ply: number;
}

/** Positions to measure: the opening tree from the start position by book moves (both sides
 *  move there), each with the position after every book move, nearest the start first. */
function positionsOf(entries: BookEntry[]): { tasks: Task[]; unreached: number } {
  const byKey = new Map<string, BookEntry[]>();
  for (const e of entries) (byKey.get(e.key) ?? byKey.set(e.key, []).get(e.key)!).push(e);
  const ply = new Map<string, number>();
  const startKey = bookKey(START_FEN);
  ply.set(startKey, 0);
  let level = [startKey];
  for (let d = 0; level.length; d++) {
    const next: string[] = [];
    for (const key of level) {
      const g = new Game(rules, key + " 0 1", true);
      for (const e of byKey.get(key) ?? []) {
        const m = g.legalMoves().find((x) => bookMoveName(x) === e.move);
        if (!m || !g.play(m.uci)) continue;
        const child = bookKey(g.fen());
        g.undo();
        if (!ply.has(child)) {
          ply.set(child, d + 1);
          next.push(child);
        }
      }
    }
    level = next;
  }
  let unreached = 0;
  for (const key of byKey.keys())
    if (!ply.has(key)) {
      unreached++;
      if (opts.all) ply.set(key, 99);
    }
  const tasks = [...ply].map(([key, p]) => ({ key, ply: p })).sort((a, b) => a.ply - b.ply);
  return { tasks, unreached };
}

// --- measuring --------------------------------------------------------------------------------

/** The record of one position, searching every legal move (a move's score is the negated
 *  score of the position after it). */
async function measure(engine: UciEngine, key: string): Promise<SharpRecord | null> {
  const fen = key + " 0 1";
  const g = new Game(rules, fen, true);
  const legal = g.legalMoves();
  if (!legal.length) return null;
  const scores: number[] = [];
  if (legal.length === 1) scores.push(0); // nothing to find; no search needed
  else {
    for (const m of legal) {
      g.play(m.uci);
      const state = g.state();
      g.undo();
      if (state === "checkmate") scores.push(10000);
      else if (state !== "ongoing") scores.push(0);
      else scores.push(-(await engine.search(fen, [bookMoveName(m)], opts.probeNodes)));
    }
  }
  const s = computeSharpness(scores);
  return s && { key, ...s, nodes: opts.probeNodes, net: engine.net };
}

function writeAtomic(path: string, data: string): void {
  writeFileSync(path + ".tmp", data);
  renameSync(path + ".tmp", path);
}

const records = new Map<string, SharpRecord>();

function save(): void {
  writeAtomic(
    out!,
    JSON.stringify({ format: SHARP_FILE_FORMAT, version: 1, created: new Date().toISOString(), probeNodes: opts.probeNodes, records: [...records.values()] }),
  );
}

// --- main -------------------------------------------------------------------------------------

const book = await readBook(opts.book);
const known = new Map<string, SharpRecord>();
mergeSharpRecords(known, book.sharpness);
if (existsSync(out)) {
  const file = JSON.parse(readFileSync(out, "utf8"));
  if (file.format !== SHARP_FILE_FORMAT || !Array.isArray(file.records)) throw new Error(`${out} is not a sharpness file`);
  const mine = file.records.filter(isSharpRecord) as SharpRecord[];
  mergeSharpRecords(records, mine);
  mergeSharpRecords(known, mine);
}
const { tasks, unreached } = positionsOf(book.entries);
console.log(
  `${book.entries.length.toLocaleString("en")} book moves; ${tasks.length.toLocaleString("en")} positions in the opening tree` +
    (unreached ? `, ${unreached.toLocaleString("en")} book positions not reached from the start position ${opts.all ? "(included)" : "(skipped, --all includes them)"}` : "") +
    `; ${known.size.toLocaleString("en")} already measured.`,
);

// Which engine net will measure? Needed to tell records of another net.
const first = new UciEngine(opts.engine);
await first.init();
const net = first.net;

let todo = tasks.filter((t) => {
  const r = known.get(t.key);
  if (!r || r.nodes < opts.probeNodes) return true;
  return opts.refreshOtherNets && r.net !== net;
});
if (opts.limit) todo = todo.slice(0, opts.limit);
console.log(`${todo.length.toLocaleString("en")} positions to measure with ${opts.probeNodes.toLocaleString("en")} nodes per move (net ${net || "?"}).`);

if (opts.dryRun || !todo.length) {
  if (opts.dryRun && todo.length) {
    const t0 = Date.now();
    const probe = todo.find((t) => t.ply > 4) ?? todo[0];
    await measure(first, probe.key);
    const secs = (Date.now() - t0) / 1000;
    const total = (todo.length * secs) / opts.workers;
    console.log(`One position took ${secs.toFixed(1)} s; about ${(total / 3600).toFixed(1)} h with ${opts.workers} workers.`);
  }
  first.quit();
  process.exit(0);
}

const engines: UciEngine[] = [first];
for (let i = 1; i < Math.min(opts.workers, todo.length); i++) {
  const e = new UciEngine(opts.engine);
  await e.init();
  engines.push(e);
}

process.on("SIGINT", () => {
  if (stopping) {
    save();
    process.exit(130);
  }
  stopping = true;
  console.log("Stopping: finishing the running positions (Ctrl-C again to stop at once).");
});

const started = Date.now();
const deadline = opts.hours ? started + opts.hours * 3600_000 : Infinity;
let next = 0;
let done = 0;
let lastSave = Date.now();
let lastReport = 0;

async function worker(engine: UciEngine): Promise<void> {
  while (!stopping && next < todo.length) {
    if (Date.now() > deadline) {
      stopping = true;
      console.log("Time is up: finishing the running positions.");
      break;
    }
    const task = todo[next++];
    const rec = await measure(engine, task.key);
    if (rec) records.set(rec.key, rec);
    done++;
    if (Date.now() - lastSave > 60_000) {
      save();
      lastSave = Date.now();
    }
    if (Date.now() - lastReport > 30_000) {
      lastReport = Date.now();
      const min = (Date.now() - started) / 60_000;
      const left = ((todo.length - done) * min) / done;
      console.log(`[${new Date().toTimeString().slice(0, 8)}] ${done.toLocaleString("en")} / ${todo.length.toLocaleString("en")} positions, ${min.toFixed(0)} min elapsed, about ${(left / 60).toFixed(1)} h left`);
    }
  }
}

await Promise.all(engines.map(worker));
finished = true;
save();
for (const e of engines) e.quit();
console.log(`${stopping ? "Stopped" : "Done"}: ${records.size.toLocaleString("en")} sharpness records in ${out} (${done.toLocaleString("en")} measured in this run).`);
process.exit(0);
