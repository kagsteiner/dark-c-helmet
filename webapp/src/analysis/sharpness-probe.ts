// Measuring the sharpness of a position in the browser, inside a game review: the review's own
// search gives the best move and its score, then every other legal move is looked at briefly,
// and the moves near the one-pawn edge get a second, longer look (they decide n). A rougher,
// faster version of tools/book-sharpness.ts. See DESIGN.md, "Sharpness".
import { bookScore } from "../book/book-logic.ts";
import { clampScore, computeSharpness, SHARP_WINDOW_CP, type Sharpness } from "../book/sharpness.ts";
import type { Game } from "../chess/game.ts";
import type { Engine, EnginePosition } from "../engine/engine.ts";

/** Share of a review's time per position that goes to sharpness (the rest to the evaluation). */
export const SHARP_SHARE = 0.7;
/** Of the sharpness time: the brief look at every move (the rest goes to the second look). */
const FIRST_LOOK_SHARE = 0.4;
/** Moves this close to the edge of the window (beyond it, too) get the second look. */
const EDGE_MARGIN_CP = 50;
const MIN_NODES = 2_000;

/** Indexes of the moves worth a second look: not clearly inside or outside the window. The
 *  best move is left out when its score is already known from the evaluation (`skip`). */
export function nearEdge(scores: number[], skip = -1): number[] {
  const best = Math.max(...scores.map(clampScore));
  const edge = best - SHARP_WINDOW_CP;
  return scores
    .map((s, i) => [clampScore(s), i] as const)
    .filter(([s, i]) => i !== skip && Math.abs(s - edge) <= EDGE_MARGIN_CP)
    .map(([, i]) => i);
}

/** Nodes for a search of about `ms` on this device ("go nodes" counts the main thread's nodes). */
function nodesFor(engine: Engine, ms: number): number {
  const nps = engine.nps > 0 ? engine.nps : 300_000;
  return Math.max(MIN_NODES, Math.floor((nps * ms) / 1000 / Math.max(1, engine.currentOptions.threads)));
}

/**
 * The sharpness of `game`'s position (at `pos`), in about `ms`. `main`: the review's search of
 * the position (best move, mover's score), so the best move needs no probe. Null when cancelled
 * (`cancelled` is polled between searches) or the game is over.
 */
export async function measureSharpness(
  engine: Engine,
  game: Game,
  pos: EnginePosition,
  ms: number,
  main: { uci: string; score: number } | null,
  cancelled: () => boolean,
): Promise<Sharpness | null> {
  if (game.state() !== "ongoing") return null;
  const legal = game.legalMoves();
  if (legal.length === 1) return computeSharpness([0]);
  const scores: number[] = new Array(legal.length).fill(0);
  const toSearch: number[] = [];
  legal.forEach((m, i) => {
    if (main && m.uci === main.uci) {
      scores[i] = main.score;
      return;
    }
    game.play(m.uci);
    const state = game.state();
    game.undo();
    if (state === "checkmate") scores[i] = 10000;
    else if (state !== "ongoing") scores[i] = 0;
    else toSearch.push(i);
  });
  const skip = main ? legal.findIndex((m) => m.uci === main.uci) : -1;
  const probe = async (i: number, nodes: number): Promise<boolean> => {
    const r = await engine.search({ ...pos, moves: [...pos.moves, legal[i].uci] }, { nodes }, undefined, false);
    if (cancelled() || !r.info) return false;
    scores[i] = -bookScore(r.info.score);
    return true;
  };
  const first = nodesFor(engine, (ms * FIRST_LOOK_SHARE) / Math.max(1, toSearch.length));
  for (const i of toSearch) if (!(await probe(i, first))) return null;
  const second = nearEdge(scores, skip).filter((i) => toSearch.includes(i));
  if (second.length) {
    const nodes = nodesFor(engine, (ms * (1 - FIRST_LOOK_SHARE)) / second.length);
    if (nodes > first) for (const i of second) if (!(await probe(i, nodes))) return null;
  }
  return computeSharpness(scores);
}
