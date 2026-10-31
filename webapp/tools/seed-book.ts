// Seed book generator: builds an opening book with the native engine, to be loaded into the
// web app with "Merge from file" on the Book screen.
//
// The opening tree is expanded level by level from the start position(s). Every position gets
// a deep search (its best move becomes the book entry). Where the tree should branch, every
// legal move gets a short probe search, and the best alternatives within a margin are
// explored as well, so that the book also covers moves a human might play.
//
// Each engine process searches single-threaded with a fixed node count, so a book entry means
// the same in the browser (where the node budget is compared) as here.
//
// Usage (from webapp/, after `npm run engine`):
//   node tools/seed-book.ts --out ~/chess-data/seed-standard.json
//   node tools/seed-book.ts --out ~/chess-data/seed-960.json --variant chess960 --positions all \
//        --widths 2,2,2,2 --max-move 10
// Options:
//   --out FILE           book file (resumed if it exists; FILE.state.json keeps the tree)
//   --variant V          standard (default) or chess960
//   --positions P        chess960 only: "all", a count of random start positions, or "a-b"
//   --nodes N            nodes per book move (default 50000000)
//   --probe-nodes N      nodes per probe of an alternative (default 200000)
//   --widths W,W,...     moves explored per ply from the start (default 3,3,3,3,2,2,2,2,2,2;
//                        later plies follow the best move only)
//   --margin CP          alternatives must be within this of the best probe (default 60)
//   --max-move M         last move number with book entries (default 20, the app's limit)
//   --workers N          engine processes (default: logical cores - 1)
//   --hash MB            hash per engine process (default 64)
//   --engine PATH        native engine (default ../bin/darkhelmet)
// Ctrl-C once: finish the running searches, save, stop. Twice: save and stop at once.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  BOOK_FILE_FORMAT,
  bookKey,
  bookMoveName,
  bookScore,
  isBookEntry,
  moveNumber,
  type BookEntry,
} from "../src/book/book-logic.ts";
import { chess960Fen } from "../src/chess/chess960.ts";
import { Game, START_FEN } from "../src/chess/game.ts";
import { Rules } from "../src/chess/rules.ts";

// --- options --------------------------------------------------------------------------------

function parseArgs(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    m.set(argv[i].slice(2), argv[i + 1] ?? "");
    i++;
  }
  return m;
}

const args = parseArgs(process.argv.slice(2));
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const out = args.get("out");
if (!out) {
  console.error("usage: node tools/seed-book.ts --out FILE [options] (see the comment at the top of this file)");
  process.exit(2);
}
const opts = {
  variant: args.get("variant") ?? "standard",
  positions: args.get("positions") ?? "all",
  nodes: num("nodes", 50_000_000),
  probeNodes: num("probe-nodes", 200_000),
  widths: (args.get("widths") ?? "3,3,3,3,2,2,2,2,2,2").split(",").map(Number),
  margin: num("margin", 60),
  maxMove: num("max-move", 20),
  workers: num("workers", Math.max(1, availableParallelism() - 1)),
  hash: num("hash", 64),
  engine: args.get("engine") ?? fileURLToPath(new URL("../../bin/darkhelmet", import.meta.url)),
};
const stateFile = out + ".state.json";

function roots(): string[] {
  if (opts.variant === "standard") return [START_FEN];
  if (opts.variant !== "chess960") throw new Error("--variant must be standard or chess960");
  const p = opts.positions;
  if (p === "all") return Array.from({ length: 960 }, (_, n) => chess960Fen(n));
  const range = /^(\d+)-(\d+)$/.exec(p);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    return Array.from({ length: b - a + 1 }, (_, i) => chess960Fen(a + i));
  }
  // A random sample of n start positions.
  const all = Array.from({ length: 960 }, (_, n) => n).sort(() => Math.random() - 0.5);
  return all.slice(0, Number(p)).map(chess960Fen);
}

// --- engine -----------------------------------------------------------------------------------

interface SearchOutcome {
  bestmove: string | null;
  score: number; // book score (side to move)
  depth: number;
  nodes: number;
}

class UciEngine {
  name = "";
  net = "";
  private proc: ChildProcessWithoutNullStreams;
  private waiting: { prefix: string; resolve: (line: string) => void } | null = null;
  private last = { score: 0, depth: 0, nodes: 0 };

  constructor(path: string) {
    // Own process group: Ctrl-C in the terminal reaches only this script, which then lets the
    // running searches finish. The engine exits by itself when its input closes.
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
    else if (t[0] === "info" && t[1] === "nodes") this.last.nodes = Number(t[2]); // totals of the search
    else if (t[0] === "info" && t.includes("score") && t.includes("pv")) {
      const s = t.indexOf("score");
      this.last.score = bookScore(t[s + 1] === "mate" ? { mate: Number(t[s + 2]) } : { cp: Number(t[s + 2]) });
      this.last.depth = Number(t[t.indexOf("depth") + 1]);
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

  async search(fen: string, moves: string[], nodes: number): Promise<SearchOutcome> {
    this.last = { score: 0, depth: 0, nodes: 0 };
    this.send(`position fen ${fen}${moves.length ? " moves " + moves.join(" ") : ""}`);
    this.send(`go nodes ${nodes}`);
    const line = await this.waitFor("bestmove");
    const move = line.split(/\s+/)[1];
    return { bestmove: move && move !== "0000" ? move : null, ...this.last };
  }

  quit(): void {
    this.send("quit");
  }
}

// --- book and tree state ----------------------------------------------------------------------

const entries = new Map<string, BookEntry>(); // id -> entry
const seedNodes = new Map<string, number>(); // key -> deepest seed search of that position
const tree = new Map<string, string[]>(); // key -> moves explored from that position (UCI)

function addEntry(e: BookEntry): void {
  entries.set(e.id, e);
  if (e.source === "seed") seedNodes.set(e.key, Math.max(seedNodes.get(e.key) ?? 0, e.nodes));
}

function load(): void {
  if (existsSync(out!)) {
    const file = JSON.parse(readFileSync(out!, "utf8"));
    if (file.format !== BOOK_FILE_FORMAT) throw new Error(`${out} is not a book file`);
    for (const e of file.entries) if (isBookEntry(e)) addEntry(e);
  }
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    for (const [k, v] of Object.entries(state.tree as Record<string, string[]>)) tree.set(k, v);
  }
}

function writeAtomic(path: string, data: string): void {
  writeFileSync(path + ".tmp", data);
  renameSync(path + ".tmp", path);
}

function save(): void {
  const book = { format: BOOK_FILE_FORMAT, version: 1, exported: new Date().toISOString(), entries: [...entries.values()] };
  writeAtomic(out!, JSON.stringify(book));
  writeAtomic(stateFile, JSON.stringify({ options: opts, tree: Object.fromEntries(tree) }));
}


// --- expansion ----------------------------------------------------------------------------------

interface Task {
  root: string;
  path: string[];
}

let stopping = false;
let finished = false;
const queue: Task[] = [];
const seen = new Set<string>();
const stats = { searched: 0, reused: 0, started: Date.now(), searchMs: 0 };

const rules = await Rules.load(
  new URL("../public/engine/", import.meta.url).href,
  readFileSync(new URL("../public/engine/dh-rules.wasm", import.meta.url)),
);

function gameAt(task: Task): Game {
  const g = new Game(rules, task.root, true);
  for (const m of task.path) g.play(m);
  return g;
}

/** Moves to explore from a position: the best one, plus alternatives where the tree branches. */
async function expand(engine: UciEngine, task: Task, game: Game): Promise<string[]> {
  const fen = game.fen();
  const key = bookKey(fen);
  const known = tree.get(key);
  if (known && (seedNodes.get(key) ?? 0) >= opts.nodes) {
    stats.reused++;
    return known;
  }
  const t0 = Date.now();
  const legal = game.legalMoves();
  const deep = await engine.search(task.root, task.path, opts.nodes);
  const best = legal.find((m) => m.uci === deep.bestmove);
  if (!best) return [];
  const name = bookMoveName(best);
  addEntry({
    id: key + " " + name,
    key,
    move: name,
    nodes: deep.nodes,
    depth: deep.depth,
    score: deep.score,
    net: engine.net,
    build: engine.name,
    source: "seed",
    date: Date.now(),
  });
  const width = opts.widths[task.path.length] ?? 1;
  const explore = [best.uci];
  if (width > 1 && legal.length > 1) {
    // Probe every move: the score after it, from the mover's side.
    const probes: { uci: string; score: number }[] = [];
    for (const m of legal) {
      const r = await engine.search(task.root, [...task.path, m.uci], opts.probeNodes);
      probes.push({ uci: m.uci, score: -r.score });
    }
    probes.sort((a, b) => b.score - a.score);
    const top = probes[0].score;
    for (const p of probes) {
      if (explore.length >= width) break;
      if (p.uci !== best.uci && p.score >= top - opts.margin) explore.push(p.uci);
    }
  }
  tree.set(key, explore);
  stats.searched++;
  stats.searchMs += Date.now() - t0;
  return explore;
}

async function worker(engine: UciEngine): Promise<void> {
  while (!stopping) {
    const task = queue.shift();
    if (!task) {
      if (busy === 0) return; // nothing queued and nobody can add more
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    busy++;
    try {
      const game = gameAt(task);
      if (game.state() === "ongoing" && moveNumber(game.fen()) <= opts.maxMove) {
        for (const m of await expand(engine, task, game)) {
          const child = gameAt({ root: task.root, path: [...task.path, m] });
          const key = bookKey(child.fen());
          if (seen.has(key)) continue; // transposition: already queued or done
          seen.add(key);
          queue.push({ root: task.root, path: [...task.path, m] });
        }
      }
    } finally {
      busy--;
    }
    if (Date.now() - lastSave > 60_000) {
      lastSave = Date.now();
      save();
    }
  }
}
let busy = 0;
let lastSave = Date.now();

function report(): void {
  const elapsed = (Date.now() - stats.started) / 1000;
  const per = stats.searched ? stats.searchMs / stats.searched / 1000 : 0;
  const ply = queue[0]?.path.length ?? "-";
  console.log(
    `[${new Date().toLocaleTimeString("en-GB")}] ${stats.searched} positions searched, ${stats.reused} from the state file, ` +
      `${queue.length} queued (next at ply ${ply}), ${entries.size} book moves, ` +
      `${per.toFixed(1)} s per position per engine, ${Math.round(elapsed / 60)} min elapsed`,
  );
}

// Upper bound of the tree size (without transpositions), for orientation.
function estimate(): number {
  let total = 0,
    level = 1;
  for (let ply = 0; ply <= 2 * opts.maxMove - 1; ply++) {
    total += level;
    level *= opts.widths[ply] ?? 1;
  }
  return total * roots().length;
}

// --- main -------------------------------------------------------------------------------------

load();
const startRoots = roots();
for (const root of startRoots) {
  const key = bookKey(root);
  if (!seen.has(key)) {
    seen.add(key);
    queue.push({ root, path: [] });
  }
}
console.log(
  `Seed book: ${opts.variant}, ${startRoots.length} start position(s), widths ${opts.widths.join(",")}, ` +
    `${opts.nodes.toLocaleString("en")} nodes per move, ${opts.workers} engines. ` +
    `At most ~${estimate().toLocaleString("en")} positions (fewer with transpositions and forced lines). ` +
    `${entries.size} book moves loaded from ${out}.`,
);

const engines = Array.from({ length: opts.workers }, () => new UciEngine(opts.engine));
await Promise.all(engines.map((e) => e.init()));
console.log(`Engine: ${engines[0].name}, net ${engines[0].net}`);

let interrupts = 0;
process.on("SIGINT", () => {
  interrupts++;
  stopping = true;
  if (interrupts === 1) {
    console.log("\nStopping after the running searches (Ctrl-C again to stop at once)…");
  } else {
    save();
    console.log(`Saved ${entries.size} book moves to ${out}.`);
    process.exit(130);
  }
});
const timer = setInterval(report, 60_000);

await Promise.all(engines.map((e) => worker(e)));
clearInterval(timer);
save();
report();
finished = true;
for (const e of engines) e.quit();
console.log(`${stopping ? "Stopped" : "Done"}: ${entries.size} book moves in ${out}. Load it in the app with Book → Merge from file.`);
