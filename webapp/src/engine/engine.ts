// UCI client on top of an EngineTransport: one search at a time, "info" parsing, stop.
// The single-threaded WebAssembly build cannot see "stop" during a search; there, stopping
// restarts the engine (losing the hash table, which is acceptable for the fallback).
import { load, save } from "../storage.ts";
import { WasmEngineTransport, threadsAvailable, type EngineTransport, type ProgressHandler } from "./transport.ts";

const NPS_KEY = "engine-nps";

export interface SearchInfo {
  depth: number;
  seldepth: number;
  /** Centipawns from the side to move, or mate in N moves (negative: getting mated). */
  score: { cp: number } | { mate: number };
  nodes: number;
  nps: number;
  time: number;
  pv: string[];
}

export interface SearchLimits {
  wtime?: number;
  btime?: number;
  winc?: number;
  binc?: number;
  movestogo?: number;
  movetime?: number;
  depth?: number;
  nodes?: number;
  infinite?: boolean;
}

export interface EnginePosition {
  startFen: string;
  moves: string[];
  chess960: boolean;
}

export interface SearchResult {
  /** null if the search was stopped before it produced a move (single-threaded restart). */
  bestmove: string | null;
  /** The last complete "info" line. */
  info: SearchInfo | null;
}

export interface EngineOptions {
  threads: number;
  hashMb: number;
}

/** Default resources: phones and tablets get 2 threads and 64 MB, desktops cores - 1 (max 16). */
export function defaultEngineOptions(): EngineOptions {
  const touch = matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints > 0;
  const cores = navigator.hardwareConcurrency || 2;
  if (!threadsAvailable()) return { threads: 1, hashMb: touch ? 64 : 128 };
  return touch ? { threads: 2, hashMb: 64 } : { threads: Math.max(1, Math.min(16, cores - 1)), hashMb: 256 };
}

export function parseInfo(line: string): SearchInfo | null {
  const t = line.split(/\s+/);
  if (t[0] !== "info" || !t.includes("pv") || !t.includes("score")) return null;
  const num = (key: string) => Number(t[t.indexOf(key) + 1]);
  const s = t.indexOf("score");
  const score = t[s + 1] === "mate" ? { mate: Number(t[s + 2]) } : { cp: Number(t[s + 2]) };
  return {
    depth: num("depth"),
    seldepth: t.includes("seldepth") ? num("seldepth") : 0,
    score,
    nodes: t.includes("nodes") ? num("nodes") : 0,
    nps: t.includes("nps") ? num("nps") : 0,
    time: t.includes("time") ? num("time") : 0,
    pv: t.slice(t.indexOf("pv") + 1),
  };
}

interface Running {
  resolve: (r: SearchResult) => void;
  info: SearchInfo | null;
  onInfo?: (info: SearchInfo) => void;
  done: Promise<SearchResult>;
}

export class Engine {
  name = "";
  net = "";
  /** Nodes per second on this device with the current settings (moving average of searches
   *  of at least a second; remembered between visits). Turns a time budget into nodes. */
  nps = 0;
  private transport: EngineTransport;
  private options: EngineOptions;
  private onProgress?: ProgressHandler;
  private running: Running | null = null;
  private waiters: { prefix: string; resolve: (line: string) => void }[] = [];

  private constructor(transport: EngineTransport, options: EngineOptions, onProgress?: ProgressHandler) {
    this.transport = transport;
    this.options = options;
    this.onProgress = onProgress;
  }

  static async start(options = defaultEngineOptions(), onProgress?: ProgressHandler): Promise<Engine> {
    const transport = await WasmEngineTransport.create(threadsAvailable(), onProgress);
    const engine = new Engine(transport, options, onProgress);
    await engine.handshake();
    const saved = await load<{ threads: number; nps: number }>(NPS_KEY);
    if (saved && saved.threads === options.threads) engine.nps = saved.nps;
    return engine;
  }

  get canStop(): boolean {
    return this.transport.canStop;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  private async handshake(): Promise<void> {
    this.transport.onLine((line) => this.onLine(line));
    this.transport.send("uci");
    await this.waitFor("uciok");
    this.transport.send(`setoption name Threads value ${this.options.threads}`);
    this.transport.send(`setoption name Hash value ${this.options.hashMb}`);
    this.transport.send("isready");
    await this.waitFor("readyok");
  }

  private waitFor(prefix: string): Promise<string> {
    return new Promise((resolve) => this.waiters.push({ prefix, resolve }));
  }

  private onLine(line: string): void {
    if (line.startsWith("id name ")) this.name = line.slice(8);
    else if (line.startsWith("info string net ")) this.net = line.slice(16);
    else if (line.startsWith("info ") && this.running) {
      const info = parseInfo(line);
      if (info) {
        this.running.info = info;
        this.running.onInfo?.(info);
      }
    } else if (line.startsWith("bestmove") && this.running) {
      const r = this.running;
      this.running = null;
      const move = line.split(/\s+/)[1];
      if (r.info && r.info.time >= 1000 && r.info.nps > 0) {
        this.nps = this.nps ? Math.round(this.nps * 0.7 + r.info.nps * 0.3) : r.info.nps;
        save(NPS_KEY, { threads: this.options.threads, nps: this.nps });
      }
      r.resolve({ bestmove: move && move !== "0000" ? move : null, info: r.info });
    }
    const i = this.waiters.findIndex((w) => line.startsWith(w.prefix));
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve(line);
  }

  /** Starts a search. A search still running is stopped first. */
  async search(pos: EnginePosition, limits: SearchLimits, onInfo?: (info: SearchInfo) => void): Promise<SearchResult> {
    await this.stop();
    this.transport.send(`setoption name UCI_Chess960 value ${pos.chess960}`);
    const moves = pos.moves.length ? " moves " + pos.moves.join(" ") : "";
    this.transport.send(`position fen ${pos.startFen}${moves}`);
    const go = Object.entries(limits)
      .filter(([, v]) => v !== undefined && v !== false)
      .map(([k, v]) => (v === true ? k : `${k} ${Math.max(0, Math.round(v as number))}`))
      .join(" ");
    let resolve!: (r: SearchResult) => void;
    const done = new Promise<SearchResult>((r) => (resolve = r));
    this.running = { resolve, info: null, onInfo, done };
    this.transport.send(`go ${go}`);
    return done;
  }

  /** Stops the running search (if any) and waits until the engine is idle. */
  async stop(): Promise<void> {
    const r = this.running;
    if (!r) return;
    if (this.canStop) {
      this.transport.send("stop");
      await r.done;
      return;
    }
    // Single-threaded: restart the engine.
    this.running = null;
    this.transport.close();
    this.transport = await WasmEngineTransport.create(false, this.onProgress);
    this.waiters = [];
    await this.handshake();
    r.resolve({ bestmove: null, info: r.info });
  }

  newGame(): void {
    if (!this.running) this.transport.send("ucinewgame");
  }

  /** A short search so the browser optimises the engine code before the first real move. */
  async warmUp(): Promise<void> {
    await this.search({ startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", moves: [], chess960: false }, { movetime: 1500 });
    this.newGame();
  }
}
