// Measuring the sharpness of a position in the browser: every legal move gets a short search
// with a fixed node count (a quicker, rougher version of tools/book-sharpness.ts).
import { bookScore } from "../book/book-logic.ts";
import { computeSharpness, type Sharpness } from "../book/sharpness.ts";
import { Game } from "../chess/game.ts";
import type { Rules } from "../chess/rules.ts";
import type { Engine } from "../engine/engine.ts";

/** Nodes per legal move so that a position takes about `seconds` on this device. */
export function probeNodes(nps: number, legal: number, seconds = 1.5): number {
  const speed = nps > 0 ? nps : 100_000;
  return Math.max(10_000, Math.min(300_000, Math.floor((speed * seconds) / Math.max(1, legal))));
}

/** The sharpness after `moves` from the start position, or null when there is no legal move
 *  (or the search was cancelled: `cancelled` is polled between moves). */
export async function probeSharpness(
  engine: Engine,
  rules: Rules,
  line: { startFen: string; chess960: boolean; moves: string[] },
  cancelled: () => boolean,
): Promise<Sharpness | null> {
  const g = new Game(rules, line.startFen, line.chess960);
  for (const m of line.moves) if (!g.play(m)) return null;
  if (g.state() !== "ongoing") return null;
  const legal = g.legalMoves();
  if (legal.length === 1) return computeSharpness([0]);
  const nodes = probeNodes(engine.nps, legal.length);
  const scores: number[] = [];
  for (const m of legal) {
    if (cancelled()) return null;
    g.play(m.uci);
    const state = g.state();
    g.undo();
    if (state === "checkmate") scores.push(10000);
    else if (state !== "ongoing") scores.push(0);
    else {
      const r = await engine.search({ startFen: line.startFen, moves: [...line.moves, m.uci], chess960: line.chess960 }, { nodes });
      if (cancelled() || !r.info) return null;
      scores.push(-bookScore(r.info.score));
    }
  }
  return computeSharpness(scores);
}
