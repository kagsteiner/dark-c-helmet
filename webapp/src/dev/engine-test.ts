// Manual checks for M0: the WebAssembly engine and the rules module in the browser.
import { Rules } from "../chess/rules";
import { threadsAvailable, WasmEngineTransport, type EngineTransport } from "../engine/transport";
import { PERFT_CASES } from "./perft-cases";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $<HTMLPreElement>("log");
const log = (text: string) => {
  logEl.textContent += text + "\n";
  logEl.scrollTop = logEl.scrollHeight;
};

$("env").textContent =
  `crossOriginIsolated: ${globalThis.crossOriginIsolated}, threads available: ${threadsAvailable()}, ` +
  `cores: ${navigator.hardwareConcurrency}`;

let engine: EngineTransport | null = null;
const waiters: { prefix: string; resolve: (line: string) => void }[] = [];

function waitFor(prefix: string): Promise<string> {
  return new Promise((resolve) => waiters.push({ prefix, resolve }));
}

function send(line: string) {
  if (!engine) return log("start the engine first");
  log("> " + line);
  engine.send(line);
}

$("start").onclick = async () => {
  engine?.close();
  const t0 = performance.now();
  engine = await WasmEngineTransport.create(!$<HTMLInputElement>("single").checked && threadsAvailable());
  log(`engine loaded in ${Math.round(performance.now() - t0)} ms (canStop: ${engine.canStop})`);
  engine.onLine((line) => {
    log(line);
    const i = waiters.findIndex((w) => line.startsWith(w.prefix));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(line);
  });
  send(`setoption name Threads value ${$<HTMLInputElement>("threads").value}`);
  send("isready");
  await waitFor("readyok");
};

$("uci").onclick = () => send("uci");

$("movetime").onclick = async () => {
  send("position startpos moves e2e4 e7e5");
  send("go movetime 3000");
  const t0 = performance.now();
  await waitFor("bestmove");
  log(`bestmove after ${Math.round(performance.now() - t0)} ms`);
};

$("infinite").onclick = async () => {
  send("position startpos");
  send("go infinite");
  setTimeout(() => send("stop"), 3000);
  const t0 = performance.now();
  await waitFor("bestmove");
  log(`bestmove after ${Math.round(performance.now() - t0)} ms`);
};

$("bench").onclick = () => send("bench");

let rules: Rules | null = null;
const getRules = async () => (rules ??= await Rules.load());

$("perft").onclick = async () => {
  const r = await getRules();
  let failed = 0;
  for (const c of PERFT_CASES) {
    r.setFen(c.fen, c.chess960);
    const t0 = performance.now();
    const nodes = r.perft(c.depth);
    const ok = nodes === c.nodes;
    if (!ok) failed++;
    log(`${ok ? "ok  " : "FAIL"} depth ${c.depth} ${nodes} (expected ${c.nodes}) ${Math.round(performance.now() - t0)} ms  ${c.fen}`);
  }
  log(failed ? `perft: ${failed} FAILED` : `perft: all ${PERFT_CASES.length} ok`);
};

$("states").onclick = async () => {
  const r = await getRules();
  const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const checks: [string, string, boolean, string[], string][] = [
    ["start", START, false, [], "ongoing"],
    ["fool's mate", START, false, ["f2f3", "e7e5", "g2g4", "d8h4"], "checkmate"],
    ["stalemate", "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", false, [], "stalemate"],
    ["threefold", START, false, ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"], "threefold"],
    ["twofold is not a draw", START, false, ["g1f3", "g8f6", "f3g1", "f6g8"], "ongoing"],
    ["fifty moves", "8/8/4k3/8/8/4K3/8/R7 w - - 99 80", false, ["a1a2"], "fifty"],
    ["K+N vs K", "8/8/4k3/8/8/4K3/8/N7 w - - 0 1", false, [], "material"],
    ["960 O-O as king takes rook", "4k3/8/8/8/8/8/8/1R2K1R1 w GB - 0 1", true, ["e1g1"], "ongoing"],
  ];
  for (const [name, fen, c960, moves, expected] of checks) {
    r.setFen(fen, c960);
    const played = moves.every((m) => r.play(m));
    const state = r.state();
    log(`${played && state === expected ? "ok  " : "FAIL"} ${name}: ${state}${played ? "" : " (a move was rejected)"}`);
  }
  r.setFen("4k3/8/8/8/8/8/8/1R2K1R1 w GB - 0 1", true);
  const castles = r.moves().filter((m) => m.castle);
  log(`960 castling moves: ${JSON.stringify(castles)}`);
  r.setFen(START, false);
  r.play("e2e4");
  log(`after e2e4: ${r.fen()}; undo: ${r.undo()}; ${r.fen()}`);
};

