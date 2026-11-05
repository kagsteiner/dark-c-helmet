// The running exploration of one tab (DESIGN.md, "Exploring"): searches one position after the
// other for a fixed node count, so a hidden tab that Chrome slows down still produces searches
// of the same depth. Each search starts when the last one ends, with no timers involved. Whether
// exploring is on is remembered: an open Explore page carries on after a reload.
import { formatLine, pickStart, PROBE_NODES, Walker, type ExploreMix, type ExploreRecord } from "./explore.ts";
import { lookup, record, recordMoveLeadingHere } from "./book.ts";
import { bookScore } from "./book-logic.ts";
import { CONTRIB_MIN_NODES } from "./contrib.ts";
import { san } from "../chess/san.ts";
import type { Rules } from "../chess/rules.ts";
import type { Engine } from "../engine/engine.ts";
import { load, loadAll, removeAll, save } from "../storage.ts";

const CONFIG = "explore";
const LOG_PREFIX = "explore-log/";
const LOCK = "dark-c-helmet-explore";
const OTHER_TAB_RETRY_MS = 30e3;
const MEASURE_MS = 3000;

export interface ExploreConfig {
  on: boolean;
  seconds: number;
  mix: ExploreMix;
  /** Nodes per search (all threads); measured when exploring is started. */
  nodes: number;
}

export type ExploreStatus = "stopped" | "no-engine" | "measuring" | "walking" | "searching" | "battery" | "other-tab";

/** Nodes per second, per tab state, over this session. */
interface Speed {
  nodes: number;
  ms: number;
}

export class Explorer {
  config: ExploreConfig = { on: false, seconds: 30, mix: "mixed", nodes: 0 };
  status: ExploreStatus = "stopped";
  /** The line being searched, and how deep it is so far. */
  current = "";
  depth = 0;
  searched = 0;
  readonly speed: Record<"visible" | "hidden", Speed> = { visible: { nodes: 0, ms: 0 }, hidden: { nodes: 0, ms: 0 } };
  onChange: () => void = () => {};
  onRecord: (r: ExploreRecord) => void = () => {};

  private rules: Rules;
  private engine: () => Engine | null;
  private run: { active: boolean } | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private onBattery = false;
  private powerBack: (() => void) | null = null;
  private walker: Walker | null = null;
  private looping: { active: boolean } | null = null;
  /** The last loop has ended and let go of the lock. */
  private finished: Promise<unknown> = Promise.resolve();

  constructor(rules: Rules, engine: () => Engine | null) {
    this.rules = rules;
    this.engine = engine;
    this.watchBattery();
  }

  /** The page is shown: carries on if exploring is on. */
  async attach(): Promise<void> {
    this.config = { ...this.config, ...(await load<Partial<ExploreConfig>>(CONFIG)) };
    this.begin();
  }

  /** The page is left. Exploring stays on, for the next time the page is opened. */
  detach(): void {
    this.halt();
  }

  async start(seconds: number, mix: ExploreMix): Promise<void> {
    this.config = { on: true, seconds, mix, nodes: 0 };
    await save(CONFIG, this.config);
    this.begin();
  }

  async stop(): Promise<void> {
    this.config = { ...this.config, on: false };
    await save(CONFIG, this.config);
    this.halt();
    this.setStatus("stopped");
  }

  /** The engine has loaded. */
  engineReady(): void {
    this.begin();
  }

  private setStatus(s: ExploreStatus): void {
    this.status = s;
    this.onChange();
  }

  private halt(): void {
    clearTimeout(this.retry);
    if (this.run) this.run.active = false;
    this.run = null;
    this.powerBack?.();
    this.engine()?.stop();
  }

  private begin(): void {
    clearTimeout(this.retry);
    if (!this.config.on || this.run) return;
    if (!this.engine()) return this.setStatus("no-engine");
    const run = { active: true };
    this.run = run;
    // One explorer per browser: a second tab waits, and takes over when the first is closed.
    this.finished = this.finished.then(() =>
      navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
        if (!run.active) return;
        if (!lock) {
          this.run = null;
          this.waitForOtherTab();
          return;
        }
        await this.loop(run).catch((err) => console.error("exploring stopped:", err));
      }),
    );
  }

  private waitForOtherTab(): void {
    this.setStatus("other-tab");
    this.retry = setTimeout(async () => {
      this.config = { ...this.config, ...(await load<Partial<ExploreConfig>>(CONFIG)) };
      if (this.config.on) this.begin();
      else this.setStatus("stopped");
    }, OTHER_TAB_RETRY_MS);
  }

  private watchBattery(): void {
    const nav = navigator as Navigator & { getBattery?: () => Promise<EventTarget & { charging: boolean }> };
    nav.getBattery?.().then((battery) => {
      const update = () => {
        this.onBattery = !battery.charging;
        if (this.onBattery) this.engine()?.stop(); // the loop drops the search and waits
        else this.powerBack?.();
      };
      battery.addEventListener("chargingchange", update);
      update();
    });
  }

  private async loop(run: { active: boolean }): Promise<void> {
    const engine = this.engine()!;
    this.looping = run;
    const threads = () => engine.currentOptions.threads;
    const walker = (this.walker ??= new Walker({
      rules: this.rules,
      lookup,
      // "go nodes" counts the main thread's nodes, so divide by the threads.
      probe: async (pos) => {
        const r = await engine.search(pos, { nodes: Math.ceil(PROBE_NODES / threads()) }, undefined, false);
        return r.info ? bookScore(r.info.score) : null;
      },
      cancelled: () => !this.looping?.active || this.onBattery,
    }));
    while (run.active) {
      if (this.onBattery) {
        this.setStatus("battery");
        await new Promise<void>((resolve) => (this.powerBack = resolve));
        this.powerBack = null;
        continue;
      }
      if (!this.config.nodes) {
        await this.measure(engine);
        if (!this.config.nodes) continue; // interrupted
      }
      this.setStatus("walking");
      const start = pickStart(this.config.mix);
      const game = await walker.findGap(start);
      if (!run.active || this.onBattery) continue;
      if (!game) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const line = game.moves.map((m) => m.san);
      this.current = (start.number === null ? "" : `Chess960 #${start.number}: `) + (formatLine(line) || "start position");
      this.depth = 0;
      this.setStatus("searching");
      const pos = { startFen: game.startFen, moves: game.moves.map((m) => m.uci), chess960: game.chess960 };
      const result = await engine.search(
        pos,
        { nodes: Math.ceil(this.config.nodes / threads()) },
        (info) => {
          this.depth = info.depth;
          this.onChange();
        },
        false,
      );
      if (!run.active || this.onBattery || !result.bestmove || !result.info) continue;
      walker.markTried(game);
      const legal = game.legalMoves();
      const best = legal.find((m) => m.uci === result.bestmove);
      await record(game, result, engine, "analysis");
      await recordMoveLeadingHere(game, result, engine, "analysis");
      const hidden = document.visibilityState === "hidden";
      const speed = this.speed[hidden ? "hidden" : "visible"];
      speed.nodes += result.nodes;
      speed.ms += result.time;
      this.searched++;
      const entry: ExploreRecord = {
        date: Date.now(),
        number: start.number,
        line,
        move: best ? san(best, legal) : result.bestmove,
        score: bookScore(result.info.score),
        depth: result.info.depth,
        nodes: result.nodes,
        ms: result.time,
        hidden,
        fen: game.fen(),
      };
      await save(LOG_PREFIX + String(entry.date).padStart(15, "0"), entry);
      this.onRecord(entry);
    }
  }

  /** Time per position to nodes, on this device with these settings. Not part of the speed
   *  estimate for games, which other tabs share: searching here competes with them. */
  private async measure(engine: Engine): Promise<void> {
    this.setStatus("measuring");
    const start = { startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", moves: [], chess960: false };
    const r = await engine.search(start, { movetime: MEASURE_MS }, undefined, false);
    if (!this.run || r.time < MEASURE_MS / 2 || !r.nodes) return;
    const nps = (r.nodes * 1000) / r.time;
    // A little above the minimum that counts, as the helper threads vary.
    const nodes = Math.round(Math.max(this.config.seconds * nps, CONTRIB_MIN_NODES * 1.1));
    this.config = { ...this.config, nodes };
    await save(CONFIG, this.config);
  }
}

export function loadExploreLog(): Promise<ExploreRecord[]> {
  return loadAll<ExploreRecord>(LOG_PREFIX);
}

export function clearExploreLog(): Promise<void> {
  return removeAll(LOG_PREFIX);
}
