// Achievements in games with odds against the engine (see ACHIEVEMENTS.md). Each is earned in
// one game, in one of three tabs (standard, Chess960, 960²), at a takeback level (Coffeehouse:
// any, J'adoube: at most one, Touch-move: none), and remembers the longest engine time it was
// earned at. All computed from the game records, so games played before count too.
import { ODDS_ENGINE_SECONDS } from "./clocks.ts";
import type { GameRecord } from "./history.ts";
import { evalValue, HOLD_CP, LOSS_CP, type EvalPoint } from "./report.ts";

export type Tab = "standard" | "chess960" | "960x2";
export const TABS: { key: Tab; label: string }[] = [
  { key: "standard", label: "Standard" },
  { key: "chess960", label: "Chess960" },
  { key: "960x2", label: "960²" },
];

/** Takeback levels from most to least lenient; a game earns its own level and the ones before. */
export const LEVELS = [
  { name: "Coffeehouse", takebacks: Infinity, text: "any number of takebacks" },
  { name: "J'adoube", takebacks: 1, text: "at most one takeback" },
  { name: "Touch-move", takebacks: 0, text: "no takeback" },
] as const;


/** Being this far down (centipawns, player's view) makes a comeback or a swindle. */
const DOWN_CP = -300;
const CAP_CP = 1000;

/** What a game shows, for the conditions. */
export interface Facts {
  /** Full moves played. */
  moves: number;
  outcome: GameRecord["outcome"];
  /** Evaluations after the engine's moves, by ply. */
  evals: EvalPoint[];
  /** Above −1.00 through this move (from the evaluations; all moves if it never fell). */
  heldUntil: number;
  anticipated: number;
  /** Longest run of engine moves (consecutive ones) predicted as the main line. */
  predictedRun: number;
  found: number;
  foundRun: number;
  /** Longest run of the player's moves without losing ground. */
  steadyRun: number;
  /** Was the player three pawns down at some point, and back within a pawn after it? */
  wasDown: boolean;
  cameBack: boolean;
}

export interface Achievement {
  id: string;
  name: string;
  section: string;
  /** What it takes, in words. */
  text: string;
  test(f: Facts): boolean;
}

export const SECTIONS = [
  "Holding: within a pawn (above −1.00) until move N",
  "Reading the engine: its moves anticipated in your grid analysis",
  "Playing like the engine: its choice for you",
  "Not losing ground: moves in a row",
  "Enduring: reaching move N without being mated",
  "Results",
] as const;

const hold = (id: string, name: string, n: number): Achievement => ({
  id, name, section: SECTIONS[0], text: `within a pawn until move ${n}`, test: (f) => f.moves >= n && f.heldUntil >= n,
});
const endure = (id: string, name: string, n: number): Achievement => ({
  id, name, section: SECTIONS[4], text: `reach move ${n}`, test: (f) => f.moves >= n,
});

export const ACHIEVEMENTS: Achievement[] = [
  hold("book", "Out of the Book", 10),
  hold("middlegame", "Into the Middlegame", 15),
  hold("standing", "Still Standing", 20),
  hold("deep", "Deep Waters", 30),
  hold("time-control", "Time Control", 40),
  { id: "kibitzer", name: "Kibitzer", section: SECTIONS[1], text: "anticipate 3 engine moves", test: (f) => f.anticipated >= 3 },
  { id: "second", name: "Second", section: SECTIONS[1], text: "anticipate 6 engine moves", test: (f) => f.anticipated >= 6 },
  { id: "oracle", name: "Oracle", section: SECTIONS[1], text: "anticipate 10 engine moves", test: (f) => f.anticipated >= 10 },
  { id: "mind-reader", name: "Mind Reader", section: SECTIONS[1], text: "3 engine moves in a row as your main line", test: (f) => f.predictedRun >= 3 },
  { id: "great-minds", name: "Great Minds", section: SECTIONS[2], text: "the engine's choice 5 times", test: (f) => f.found >= 5 },
  { id: "silicon", name: "Silicon Touch", section: SECTIONS[2], text: "the engine's choice 10 times", test: (f) => f.found >= 10 },
  { id: "mirror", name: "Mirror Move", section: SECTIONS[2], text: "the engine's choice 3 times in a row", test: (f) => f.foundRun >= 3 },
  { id: "in-sync", name: "In Sync", section: SECTIONS[2], text: "the engine's choice 6 times in a row", test: (f) => f.foundRun >= 6 },
  { id: "hedgehog", name: "Hedgehog", section: SECTIONS[3], text: "10 moves in a row without losing ground", test: (f) => f.steadyRun >= 10 },
  { id: "fortress", name: "Fortress", section: SECTIONS[3], text: "20 moves in a row without losing ground", test: (f) => f.steadyRun >= 20 },
  endure("stubborn", "Stubborn", 20),
  endure("hard-nut", "Hard Nut", 30),
  endure("never-resign", "Never Resign", 40),
  endure("marathon", "Marathon", 60),
  endure("last-stand", "Last Stand", 80),
  { id: "comeback", name: "Comeback", section: SECTIONS[5], text: "back within a pawn after being 3 pawns down", test: (f) => f.cameBack },
  { id: "half-point", name: "Half a Point", section: SECTIONS[5], text: "a draw", test: (f) => f.outcome === "draw" },
  { id: "swindle", name: "Swindle", section: SECTIONS[5], text: "a draw after being 3 pawns down", test: (f) => f.outcome === "draw" && f.wasDown },
  { id: "helmet-off", name: "Helmet Off", section: SECTIONS[5], text: "a win", test: (f) => f.outcome === "win" },
  { id: "flag", name: "Before the Flag", section: SECTIONS[5], text: "a win in at most 40 moves", test: (f) => f.outcome === "win" && f.moves <= 40 },
];

/** The longest run of consecutive keys (stepping by 2: one side's plies) whose value passes. */
function longestRun<T>(map: Record<number, T> | undefined, ok: (v: T) => boolean): number {
  let best = 0;
  for (const [k, v] of Object.entries(map ?? {})) {
    const ply = Number(k);
    if (!ok(v) || (map![ply - 2] !== undefined && ok(map![ply - 2]))) continue; // not a run's start
    let n = 0;
    while (map![ply + 2 * n] !== undefined && ok(map![ply + 2 * n])) n++;
    best = Math.max(best, n);
  }
  return best;
}

export function factsOf(r: GameRecord): Facts {
  const moves = Math.ceil(r.plies / 2);
  const evals = [...(r.evals ?? [])].sort((a, b) => a.ply - b.ply);
  const fell = evals.find((p) => evalValue(p.e) < HOLD_CP);
  // Held through the move before the one where it fell; if it never fell, through the last
  // move with an evaluation (no evaluation, no proof).
  const last = evals.at(-1);
  const heldUntil = fell ? Math.floor(fell.ply / 2) : last ? Math.floor(last.ply / 2) + 1 : 0;
  const capped = (v: number) => Math.max(-CAP_CP, Math.min(CAP_CP, v));
  const steady: Record<number, boolean> = {};
  const at = new Map(evals.map((p) => [p.ply, evalValue(p.e)]));
  for (const p of evals) {
    const next = at.get(p.ply + 2);
    if (next !== undefined) steady[p.ply + 1] = capped(evalValue(p.e)) - capped(next) <= LOSS_CP;
  }
  let wasDown = false;
  let cameBack = false;
  for (const p of evals) {
    const v = evalValue(p.e);
    if (v <= DOWN_CP) wasDown = true;
    else if (wasDown && v >= HOLD_CP) cameBack = true;
  }
  const foresight = Object.values(r.foresight ?? {});
  return {
    moves,
    outcome: r.outcome,
    evals,
    heldUntil,
    anticipated: foresight.filter((f) => f !== "missed").length,
    predictedRun: longestRun(r.foresight, (f) => f === "predicted"),
    found: Object.values(r.found ?? {}).filter(Boolean).length,
    foundRun: longestRun(r.found, (f) => f),
    steadyRun: longestRun(steady, (s) => s),
    wasDown,
    cameBack,
  };
}

export function tabOf(r: Pick<GameRecord, "chess960" | "position960" | "black960">): Tab {
  if (!r.chess960) return "standard";
  return r.black960 !== undefined && r.black960 !== r.position960 ? "960x2" : "chess960";
}

/** Earned: per tab, achievement id and level index, the longest engine time (seconds). */
export type Earned = Record<Tab, Record<string, (number | undefined)[]>>;

/** The achievements of one game: ids with the strictest takeback level reached. */
export function gameAchievements(r: GameRecord): { id: string; level: number }[] {
  if (!r.odds) return [];
  const f = factsOf(r);
  const level = LEVELS.reduce((l, lv, i) => (r.odds!.used <= lv.takebacks ? i : l), 0);
  return ACHIEVEMENTS.filter((a) => a.test(f)).map((a) => ({ id: a.id, level }));
}

export function earnedFrom(records: GameRecord[]): Earned {
  const earned: Earned = { standard: {}, chess960: {}, "960x2": {} };
  for (const r of records) {
    if (!r.odds) continue;
    const tab = earned[tabOf(r)];
    for (const { id, level } of gameAchievements(r)) {
      const levels = (tab[id] ??= []);
      // A stricter level also earns the more lenient ones.
      for (let i = 0; i <= level; i++) levels[i] = Math.max(levels[i] ?? 0, r.odds.engineSeconds);
    }
  }
  return earned;
}

/** The next engine time to try after the longest one earned at. */
export function nextStep(seconds: number): number | null {
  return ODDS_ENGINE_SECONDS.find((s) => s > seconds) ?? null;
}

/** What a game earned beyond what the other games had (`earnedFrom` of them, without this
 *  game): an achievement level new or at a longer engine time. For the game screen. */
export function newIn(r: GameRecord, others: Earned): { id: string; level: number }[] {
  if (!r.odds) return [];
  const before = others[tabOf(r)];
  const out: { id: string; level: number }[] = [];
  for (const { id, level } of gameAchievements(r)) {
    // The strictest level that is new.
    for (let i = level; i >= 0; i--) {
      if ((before[id]?.[i] ?? 0) < r.odds.engineSeconds) {
        out.push({ id, level: i });
        break;
      }
    }
  }
  return out;
}
