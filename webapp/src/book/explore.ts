// Exploring openings in the background, without storage or engine (tested in Node): where the
// next search goes (DESIGN.md, "Exploring"). A walk starts from a start position and plays
// sensible moves until it reaches the first position the book does not cover yet.
import { chess960Fen } from "../chess/chess960.ts";
import { Game, START_FEN } from "../chess/game.ts";
import type { Rules } from "../chess/rules.ts";
import type { EnginePosition } from "../engine/engine.ts";
import { BOOK_MAX_MOVE, bookKey, moveNumber, type BookEntry } from "./book-logic.ts";
import { CONTRIB_MIN_NODES } from "./contrib.ts";

export const EXPLORE_TIMES = [10, 30, 60, 120, 300]; // seconds per position
export const EXPLORE_MIXES = { mixed: 0.7, chess960: 1, standard: 0 } as const;
export type ExploreMix = keyof typeof EXPLORE_MIXES;

/** Nodes of the short search that scores a move on the way to a gap. */
export const PROBE_NODES = 200_000;
/** Moves this close to the best probe may be played on the way, at most this many. */
export const WALK_MARGIN_CP = 60;
export const WALK_WIDTH = 4;

export interface ExploreStart {
  fen: string;
  chess960: boolean;
  /** Chess960 start number; null for standard chess. */
  number: number | null;
}

export function pickStart(mix: ExploreMix, random: () => number = Math.random): ExploreStart {
  if (random() >= EXPLORE_MIXES[mix]) return { fen: START_FEN, chess960: false, number: null };
  let n = Math.floor(random() * 960);
  if (n === 518) n = 519; // the standard position has its own book keys
  return { fen: chess960Fen(n), chess960: true, number: n };
}

export interface Probe {
  uci: string;
  /** From the side that plays the move. */
  score: number;
}

/** The moves a walk may play: near the best, best first. */
export function walkMoves(probes: Probe[]): Probe[] {
  const sorted = [...probes].sort((a, b) => b.score - a.score);
  return sorted.filter((p) => p.score >= sorted[0].score - WALK_MARGIN_CP).slice(0, WALK_WIDTH);
}

/** One of the moves, each half as likely as the one before. */
export function pickWalkMove(moves: Probe[], random: () => number = Math.random): string | null {
  if (!moves.length) return null;
  const total = moves.reduce((sum, _, i) => sum + 0.5 ** i, 0);
  let r = random() * total;
  for (let i = 0; i < moves.length; i++) {
    r -= 0.5 ** i;
    if (r < 0) return moves[i].uci;
  }
  return moves[moves.length - 1].uci;
}

export interface WalkDeps {
  rules: Rules;
  lookup(key: string): Promise<BookEntry[]>;
  /** A short search; the score for the side to move there, null if the game has ended. */
  probe(pos: EnginePosition): Promise<number | null>;
  cancelled(): boolean;
  random?: () => number;
}

export class Walker {
  private deps: WalkDeps;
  /** Searched in this session, whatever came of it (a mate ends a search early, below the
   *  depth that counts: it must not be searched again and again). */
  private tried = new Set<string>();
  /** Per position; the probes of positions near the start are needed in almost every walk. */
  private moves = new Map<string, Probe[]>();

  constructor(deps: WalkDeps) {
    this.deps = deps;
  }

  markTried(game: Game): void {
    this.tried.add(bookKey(game.fen()));
  }

  /** Walks to the first position without a deep entry; null if the walk ends without one. */
  async findGap(start: ExploreStart): Promise<Game | null> {
    const game = new Game(this.deps.rules, start.fen, start.chess960);
    while (!this.deps.cancelled()) {
      const fen = game.fen();
      if (game.state() !== "ongoing" || moveNumber(fen) > BOOK_MAX_MOVE) return null;
      const legal = game.legalMoves();
      if (legal.length === 1) {
        game.play(legal[0].uci); // nothing to search or choose
        continue;
      }
      const key = bookKey(fen);
      const covered = this.tried.has(key) || (await this.deps.lookup(key)).some((e) => e.nodes >= CONTRIB_MIN_NODES);
      if (!covered) return game;
      const uci = pickWalkMove(await this.movesFrom(game, key), this.deps.random);
      if (!uci) return null;
      game.play(uci);
    }
    return null;
  }

  private async movesFrom(game: Game, key: string): Promise<Probe[]> {
    const known = this.moves.get(key);
    if (known) return known;
    const path = game.moves.map((m) => m.uci);
    const probes: Probe[] = [];
    for (const m of game.legalMoves()) {
      const score = await this.deps.probe({ startFen: game.startFen, moves: [...path, m.uci], chess960: game.chess960 });
      if (this.deps.cancelled()) return [];
      if (score !== null) probes.push({ uci: m.uci, score: -score });
    }
    const moves = walkMoves(probes);
    this.moves.set(key, moves);
    return moves;
  }
}

/** One analyzed position in the list on the Explore page. */
export interface ExploreRecord {
  date: number;
  /** Chess960 start number; null for standard chess. */
  number: number | null;
  /** SAN from move 1. */
  line: string[];
  /** The engine's move, SAN. */
  move: string;
  /** As in the book: from the side to move, mates as ±(10000 - moves). */
  score: number;
  depth: number;
  nodes: number;
  ms: number;
  /** The tab was hidden when the search ended. */
  hidden: boolean;
  fen: string;
}

/** "1. e4 e5 2. Nf3" */
export function formatLine(line: string[]): string {
  return line.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m}` : m)).join(" ");
}

/** The move after `plies` half moves: "2... Nc6" or "3. Bb5". */
export function formatNext(plies: number, san: string): string {
  const n = Math.floor(plies / 2) + 1;
  return plies % 2 === 0 ? `${n}. ${san}` : `${n}... ${san}`;
}

/** A book score at `plies` half moves, from White's side: "+0.31", "-#5". */
export function formatScore(score: number, plies: number): string {
  const s = plies % 2 === 0 ? score : -score;
  if (Math.abs(s) > 9000) return `${s < 0 ? "-" : ""}#${10000 - Math.abs(s)}`;
  return (s < 0 ? "-" : "+") + (Math.abs(s) / 100).toFixed(2);
}
