// The log of games with odds against the engine (an experiment to find good odds levels): how
// the player did with which odds. Built from the game history on this device.
import { formatSeconds } from "./clocks.ts";
import type { GameRecord, OddsRecord, Outcome } from "./history.ts";

/** The odds of a game in words: "engine 5 s · no clock · 3 takebacks". */
export function oddsName(o: Pick<OddsRecord, "engineSeconds" | "humanMinutes" | "takebacks">): string {
  return [
    `engine ${formatSeconds(o.engineSeconds)}`,
    o.humanMinutes ? `you ${o.humanMinutes} min` : "no clock",
    o.takebacks ? `${o.takebacks} takeback${o.takebacks > 1 ? "s" : ""}` : "no takebacks",
  ].join(" · ");
}

export interface OddsTally {
  name: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  unfinished: number;
  /** Wins with the star kept (within the odds). */
  starredWins: number;
}

/** Games with odds by their odds, most played first. */
export function tallyByOdds(records: GameRecord[]): OddsTally[] {
  const map = new Map<string, OddsTally>();
  for (const r of records) {
    if (!r.odds) continue;
    const name = oddsName(r.odds);
    let t = map.get(name);
    if (!t) {
      t = { name, games: 0, wins: 0, draws: 0, losses: 0, unfinished: 0, starredWins: 0 };
      map.set(name, t);
    }
    t.games++;
    const key: Record<Outcome, keyof OddsTally> = { win: "wins", draw: "draws", loss: "losses", unfinished: "unfinished" };
    (t[key[r.outcome]] as number)++;
    if (r.outcome === "win" && r.star) t.starredWins++;
  }
  return [...map.values()].sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
}

const OUTCOME_TEXT: Record<Outcome, string> = { win: "won", draw: "draw", loss: "lost", unfinished: "not finished" };

/** One game of the log in words: "14 Nov · White · Chess960 no. 518 · won ★ · 3 of 5 takebacks · 42 moves". */
export function oddsGameLine(r: GameRecord): string {
  const o = r.odds!;
  const date = new Date(r.started).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const start = r.chess960 ? (r.black960 !== undefined && r.black960 !== r.position960 ? `960² ${r.position960}/${r.black960}` : `Chess960 no. ${r.position960 ?? "?"}`) : "standard";
  return [
    date,
    r.human === "w" ? "White" : "Black",
    start,
    OUTCOME_TEXT[r.outcome] + (r.outcome === "win" && r.star ? " ★" : ""),
    `${o.used} of ${o.takebacks} takeback${o.takebacks === 1 ? "" : "s"}`,
    `${Math.ceil(r.plies / 2)} move${Math.ceil(r.plies / 2) === 1 ? "" : "s"}`,
    ...(r.engineEval && r.outcome === "unfinished" ? [`engine's eval for you ${evalText(r.engineEval)}`] : []),
  ].join(" · ");
}

/** An evaluation from the player's point of view: "+0.35", "−4.20", "you mate in 3", "mated in 2". */
export function evalText(e: { cp: number } | { mate: number }): string {
  if ("mate" in e) return e.mate > 0 ? `you mate in ${e.mate}` : `mated in ${-e.mate}`;
  const v = e.cp / 100;
  return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
}
