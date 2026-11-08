// Chess 960² evaluator: searches the start positions where White and Black have their own
// Chess960 back ranks (960 × 960 pairs) and writes the list of balanced ones for the app
// (public/960sq/balanced.bin, one bit per pair, see src/play/balanced.ts).
//
// A start and its mirror image (files a-h flipped) are the same game, so only one of each pair
// is searched (460,800 searches) and the score is stored for both.
//
// Two passes:
//   shallow  every start with --nodes (default 1,000,000)
//   deep     the starts whose shallow score is within --window (default 70 cp) of 0, searched
//            again with --nodes (default 10,000,000), the ones closest to the --limit first
// A start is balanced when its deepest score is within --limit (default 50 cp) of 0.
//
// Usage (from webapp/, after `npm run engine`):
//   node tools/eval-960sq.ts --data ~/chess-data/960sq --pass shallow --hours 6
//   node tools/eval-960sq.ts --data ~/chess-data/960sq --pass deep --hours 8
//   node tools/eval-960sq.ts --data ~/chess-data/960sq --export public/960sq/balanced.bin
//   node tools/eval-960sq.ts --data ~/chess-data/960sq --stats
// Options:
//   --data DIR       scores (shallow.i16, deep.i16: centipawns for White, one per pair); resumed
//   --pass P         shallow or deep
//   --nodes N        nodes per search (see above)
//   --window CP      deep pass: shallow scores within this of 0 (default 70)
//   --limit CP       balanced: within this of 0 (default 50)
//   --workers N      engine processes (default: logical cores - 1)
//   --hash MB        hash per engine process (default 16)
//   --engine PATH    native engine (default ../bin/darkhelmet)
//   --hours H        stop by itself after H hours
//   --export FILE    write the balanced bitmap (deep score where there is one, else shallow)
//   --stats          print how the scores are spread
// Ctrl-C once: finish the running searches, save, stop. Twice: save and stop at once.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { backRank, chess960SquaredFen } from "../src/chess/chess960.ts";

const PAIRS = 960 * 960;
const NONE = -32768;
const MAX = 32000;

function parseArgs(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) m.set(argv[i].slice(2), "");
    else {
      m.set(argv[i].slice(2), next);
      i++;
    }
  }
  return m;
}

const args = parseArgs(process.argv.slice(2));
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const dataArg = args.get("data");
if (!dataArg) {
  console.error("usage: node tools/eval-960sq.ts --data DIR (--pass shallow|deep | --export FILE | --stats) [options]");
  process.exit(2);
}
const dataDir = dataArg.replace(/^~(?=\/|$)/, homedir());
const pass = args.get("pass");
const opts = {
  nodes: num("nodes", pass === "deep" ? 10_000_000 : 1_000_000),
  window: num("window", 70),
  limit: num("limit", 50),
  workers: num("workers", Math.max(1, availableParallelism() - 1)),
  hash: num("hash", 16),
  engine: args.get("engine") ?? fileURLToPath(new URL("../../bin/darkhelmet", import.meta.url)),
  hours: num("hours", 0),
};

// --- pairs and mirrors ------------------------------------------------------------------------

const numberOf = new Map<string, number>();
for (let n = 0; n < 960; n++) numberOf.set(backRank(n), n);
const mirrorOf = Array.from({ length: 960 }, (_, n) => numberOf.get([...backRank(n)].reverse().join(""))!);

/** The pair with both back ranks mirrored (the same game, files flipped). */
function mirrorPair(i: number): number {
  return mirrorOf[Math.floor(i / 960)] * 960 + mirrorOf[i % 960];
}

/** One of each mirror pair: the smaller index. No start is its own mirror. */
function canonical(i: number): boolean {
  return i < mirrorPair(i);
}

// --- scores -----------------------------------------------------------------------------------

function loadScores(name: string): Int16Array {
  const path = join(dataDir, name);
  if (!existsSync(path)) return new Int16Array(PAIRS).fill(NONE);
  const buf = readFileSync(path);
  if (buf.length !== PAIRS * 2) throw new Error(`${path} has the wrong size`);
  return new Int16Array(buf.buffer, buf.byteOffset, PAIRS).slice();
}

function saveScores(name: string, scores: Int16Array): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, name);
  writeFileSync(path + ".tmp", scores);
  renameSync(path + ".tmp", path);
}

const shallow = loadScores("shallow.i16");
const deep = loadScores("deep.i16");

/** The deepest score of a pair, or NONE. */
function best(i: number): number {
  return deep[i] !== NONE ? deep[i] : shallow[i];
}

// --- export and stats -------------------------------------------------------------------------

if (args.has("export")) {
  const file = args.get("export")!;
  const bits = new Uint8Array(PAIRS / 8);
  let balanced = 0, missing = 0;
  for (let i = 0; i < PAIRS; i++) {
    const s = best(i);
    if (s === NONE) missing++;
    else if (Math.abs(s) <= opts.limit) {
      bits[i >> 3] |= 1 << (i & 7);
      balanced++;
    }
  }
  if (missing === PAIRS) throw new Error("no scores yet: run --pass shallow first");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bits);
  console.log(
    `${balanced.toLocaleString("en")} of ${PAIRS.toLocaleString("en")} starts balanced (within ±${opts.limit} cp)` +
      `${missing ? `, ${missing.toLocaleString("en")} not searched yet` : ""}. Written to ${file}.`,
  );
  process.exit(0);
}

if (args.has("stats")) {
  const bands = [10, 30, 50, 70, 100, 150, 200, 300];
  for (const [name, scores] of [["shallow", shallow], ["deep", deep]] as const) {
    let n = 0, sum = 0, black = 0;
    const counts = new Array(bands.length + 1).fill(0);
    for (let i = 0; i < PAIRS; i++) {
      const s = scores[i];
      if (s === NONE) continue;
      n++;
      sum += s;
      if (s < 0) black++;
      const k = bands.findIndex((b) => Math.abs(s) <= b);
      counts[k < 0 ? bands.length : k]++;
    }
    if (!n) {
      console.log(`${name}: no scores yet`);
      continue;
    }
    console.log(`${name}: ${n.toLocaleString("en")} starts, mean ${(sum / n).toFixed(1)} cp for White, ${((100 * black) / n).toFixed(1)}% better for Black`);
    let acc = 0;
    bands.forEach((b, k) => {
      acc += counts[k];
      console.log(`  within ±${String(b).padStart(3)} cp: ${((100 * acc) / n).toFixed(1).padStart(5)}%  (${acc.toLocaleString("en")})`);
    });
  }
  let flipped = 0, both = 0;
  for (let i = 0; i < PAIRS; i++) {
    if (deep[i] === NONE || shallow[i] === NONE) continue;
    both++;
    if ((Math.abs(shallow[i]) <= opts.limit) !== (Math.abs(deep[i]) <= opts.limit)) flipped++;
  }
  if (both) console.log(`deep pass changed the verdict (±${opts.limit} cp) of ${((100 * flipped) / both).toFixed(1)}% of ${both.toLocaleString("en")} starts`);
  process.exit(0);
}

if (pass !== "shallow" && pass !== "deep") {
  console.error("--pass must be shallow or deep (or use --export / --stats)");
  process.exit(2);
}

// --- engine -----------------------------------------------------------------------------------

let stopping = false;
let finished = false;

class UciEngine {
  name = "";
  net = "";
  private proc: ChildProcessWithoutNullStreams;
  private waiting: { prefix: string; resolve: (line: string) => void } | null = null;
  private score = 0;

  constructor(path: string) {
    this.proc = spawn(path, [], { stdio: "pipe", detached: true });
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    this.proc.on("exit", (code) => {
      if (!stopping && !finished) console.error(`engine process exited (${code})`);
    });
  }

  private onLine(line: string): void {
    const t = line.split(/\s+/);
    if (line.startsWith("id name ")) this.name = line.slice(8);
    else if (line.startsWith("info string net ")) this.net = line.slice(16);
    else if (t[0] === "info" && t.includes("score") && t.includes("pv")) {
      const s = t.indexOf("score");
      const v = Number(t[s + 2]);
      this.score = t[s + 1] === "mate" ? (v > 0 ? MAX : -MAX) : Math.max(-MAX, Math.min(MAX, v));
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
    this.send("setoption name UCI_Chess960 value true");
    this.send("isready");
    await this.waitFor("readyok");
  }

  /** Score in centipawns for White (White is to move at the start). */
  async evaluate(fen: string, nodes: number): Promise<number> {
    this.score = 0;
    this.send(`position fen ${fen}`);
    this.send(`go nodes ${nodes}`);
    await this.waitFor("bestmove");
    return this.score;
  }

  quit(): void {
    this.send("quit");
  }
}

// --- the pass ---------------------------------------------------------------------------------

const target = pass === "deep" ? deep : shallow;
const file = pass === "deep" ? "deep.i16" : "shallow.i16";
const todo: number[] = [];
for (let i = 0; i < PAIRS; i++) {
  if (!canonical(i) || target[i] !== NONE) continue;
  if (pass === "deep" && (shallow[i] === NONE || Math.abs(shallow[i]) > opts.window)) continue;
  todo.push(i);
}
// Shallow pass in a fixed shuffled order, so a part of it is a fair sample of all starts.
let seed = 960;
const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
for (let k = todo.length - 1; k > 0; k--) {
  const j = Math.floor(random() * (k + 1));
  [todo[k], todo[j]] = [todo[j], todo[k]];
}
// Deep pass: the starts nearest the limit first, where the shallow verdict is least certain.
if (pass === "deep") todo.sort((a, b) => Math.abs(Math.abs(shallow[a]) - opts.limit) - Math.abs(Math.abs(shallow[b]) - opts.limit));
const total = todo.length;
const stats = { done: 0, started: Date.now(), dirty: false };

function save(): void {
  if (!stats.dirty) return;
  saveScores(file, target);
  stats.dirty = false;
}

function report(): void {
  const elapsed = (Date.now() - stats.started) / 1000;
  const rate = stats.done / Math.max(1, elapsed);
  const left = total - stats.done;
  const eta = rate > 0 ? left / rate / 3600 : 0;
  console.log(
    `[${new Date().toLocaleTimeString("en-GB")}] ${stats.done.toLocaleString("en")} of ${total.toLocaleString("en")} searched, ` +
      `${(rate * 60).toFixed(0)} per minute, ${left ? `about ${eta.toFixed(1)} h left` : "done"}, ${Math.round(elapsed / 60)} min elapsed`,
  );
  save();
}

let next = 0;
async function worker(engine: UciEngine): Promise<void> {
  while (!stopping && next < todo.length) {
    const i = todo[next++];
    const score = await engine.evaluate(chess960SquaredFen(Math.floor(i / 960), i % 960), opts.nodes);
    target[i] = score;
    target[mirrorPair(i)] = score;
    stats.done++;
    stats.dirty = true;
  }
}

console.log(
  `Chess 960² ${pass} pass: ${total.toLocaleString("en")} starts to search with ${opts.nodes.toLocaleString("en")} nodes, ` +
    `${opts.workers} engines` +
    (pass === "deep" ? `, shallow scores within ±${opts.window} cp` : "") +
    `. Data in ${dataDir}.`,
);
if (!total) process.exit(0);

const engines = Array.from({ length: opts.workers }, () => new UciEngine(opts.engine));
await Promise.all(engines.map((e) => e.init()));
console.log(`Engine: ${engines[0].name}, net ${engines[0].net}`);

let interrupts = 0;
process.on("SIGINT", () => {
  interrupts++;
  stopping = true;
  if (interrupts === 1) console.log("\nStopping after the running searches (Ctrl-C again to stop at once)…");
  else {
    stats.dirty = true;
    save();
    console.log(`Saved to ${join(dataDir, file)}.`);
    process.exit(130);
  }
});
const timer = setInterval(report, 60_000);
if (opts.hours > 0) {
  const end = new Date(Date.now() + opts.hours * 3_600_000);
  console.log(`Stopping by itself at ${end.toLocaleTimeString("en-GB")} (--hours ${opts.hours}).`);
  setTimeout(() => {
    if (stopping) return;
    stopping = true;
    console.log("Time is up: stopping after the running searches…");
  }, opts.hours * 3_600_000).unref();
}

await Promise.all(engines.map((e) => worker(e)));
clearInterval(timer);
stats.dirty = true;
report();
finished = true;
for (const e of engines) e.quit();
console.log(`${stopping ? "Stopped" : "Done"}: scores in ${join(dataDir, file)}. Export with --export public/960sq/balanced.bin.`);
