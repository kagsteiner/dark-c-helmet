// The games played on this device: one record per game, written whenever the game is saved
// (so an abandoned game counts as played). The Progress screen shows the Chess960 ones.
import { loadAll, save } from "../storage.ts";
import { notifyLocalChange } from "../sync/changes.ts";
import type { Side, TimeControl } from "./clocks.ts";

export type Outcome = "win" | "loss" | "draw" | "unfinished";

/** Gold: no undo, hint, evaluation or analysis, and within the time. Silver: over the time,
 *  but no help. null: help was used. */
export type Star = "gold" | "silver" | null;

/** "engine" (Dark C. Helmet) or a human-like profile ("1300", "1600"). */
export type OpponentKey = string;

export interface GameRecord {
  id: string;
  /** When the game was started (ms since 1970). */
  started: number;
  chess960: boolean;
  position960?: number;
  /** Chess 960²: Black's starting position (position960 is White's). Not on the Progress screen. */
  black960?: number;
  human: Side;
  opponent: OpponentKey;
  tc: TimeControl;
  outcome: Outcome;
  /** The star at the end (or at the latest save) of the game. */
  star: Star;
  plies: number;
}

const PREFIX = "game:";

export function newGameId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** The outcome of a finished game from its result text (see PlayController). */
export function outcomeOf(result: string | null): Outcome {
  if (!result) return "unfinished";
  if (result.includes("You win")) return "win";
  if (result.startsWith("Draw")) return "draw";
  return "loss";
}

export async function saveRecord(r: GameRecord): Promise<void> {
  await save(PREFIX + r.id, r);
  if (r.outcome !== "unfinished") notifyLocalChange(); // a game in progress syncs at the next start
}

/** Stores records that came from the player's other devices. */
export async function storeRecords(records: GameRecord[]): Promise<void> {
  for (const r of records) await save(PREFIX + r.id, r);
}

export function loadRecords(): Promise<GameRecord[]> {
  return loadAll<GameRecord>(PREFIX);
}

// --- the Progress grid ------------------------------------------------------------------------

/** Opponents from weakest to strongest; a tile shows the strongest one beaten. */
export const OPPONENTS: OpponentKey[] = ["1300", "1600", "engine"];

export const OPPONENT_NAMES: Record<OpponentKey, string> = {
  "1300": "1300 Elo player",
  "1600": "1600 Elo player",
  engine: "Dark C. Helmet",
};

/** A win that counts on the Progress screen: with the gold star, or against Dark C. Helmet with
 *  the silver one (nobody beats it at equal time). */
export function countsAsWin(r: Pick<GameRecord, "outcome" | "star" | "opponent">): boolean {
  return r.outcome === "win" && (r.star === "gold" || (r.star === "silver" && r.opponent === "engine"));
}

/** One side of one start position: -1 not played, 0 played without a counting win, otherwise
 *  1 + the index in OPPONENTS of the strongest opponent beaten (see countsAsWin). */
export type Level = number;

export interface Tally {
  played: number;
  wins: number;
}

export interface PositionProgress {
  /** Per side and opponent. */
  games: Record<Side, Record<OpponentKey, Tally>>;
}

export function progressByPosition(records: GameRecord[]): Map<number, PositionProgress> {
  const map = new Map<number, PositionProgress>();
  for (const r of records) {
    if (!r.chess960 || r.position960 === undefined) continue;
    if (r.black960 !== undefined && r.black960 !== r.position960) continue; // Chess 960²
    let p = map.get(r.position960);
    if (!p) {
      p = { games: { w: {}, b: {} } };
      map.set(r.position960, p);
    }
    const t = (p.games[r.human][r.opponent] ??= { played: 0, wins: 0 });
    t.played++;
    if (countsAsWin(r)) t.wins++;
  }
  return map;
}

/** Every one of the 960 start positions won against Dark C. Helmet, with either colour. */
export function allWonAgainstEngine(progress: Map<number, PositionProgress>): boolean {
  for (let n = 0; n < 960; n++) {
    const p = progress.get(n);
    if (!p?.games.w.engine?.wins && !p?.games.b.engine?.wins) return false;
  }
  return true;
}

/** The tile level of one side, over all opponents (filter null) or one. */
export function level(p: PositionProgress | undefined, side: Side, filter: OpponentKey | null): Level {
  if (!p) return -1;
  let lv = -1;
  OPPONENTS.forEach((o, i) => {
    if (filter !== null && o !== filter) return;
    const t = p.games[side][o];
    if (!t?.played) return;
    lv = Math.max(lv, t.wins ? i + 1 : 0);
  });
  return lv;
}
