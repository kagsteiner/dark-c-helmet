// A game: start position plus the moves played. The rules module holds one game at a time,
// so a Game replays itself into the module whenever another Game used it in between.
import type { GameState, LegalMove, Rules } from "./rules.ts";
import { san } from "./san.ts";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export interface PlayedMove {
  uci: string;
  san: string;
  from: number;
  to: number;
  /** Castling only: the rook's start square (-1 otherwise). */
  rook: number;
  castle: boolean;
}

let owner: Game | null = null;

export class Game {
  readonly moves: PlayedMove[] = [];
  readonly startFen: string;
  readonly chess960: boolean;
  private rules: Rules;

  constructor(rules: Rules, startFen = START_FEN, chess960 = false) {
    this.rules = rules;
    this.startFen = startFen;
    this.chess960 = chess960;
    if (!rules.setFen(startFen, chess960)) throw new Error("invalid FEN: " + startFen);
    owner = this;
  }

  private sync(): Rules {
    if (owner !== this) {
      this.rules.setFen(this.startFen, this.chess960);
      for (const m of this.moves) this.rules.play(m.uci);
      owner = this;
    }
    return this.rules;
  }

  fen(): string {
    return this.sync().fen();
  }

  legalMoves(): LegalMove[] {
    return this.sync().moves();
  }

  state(): GameState {
    return this.sync().state();
  }

  inCheck(): boolean {
    return this.sync().inCheck();
  }

  /** Side to move: "w" or "b". */
  turn(): "w" | "b" {
    return this.fen().split(" ")[1] as "w" | "b";
  }

  /** Plays a move given in UCI notation. Returns the move, or null if it is not legal. */
  play(uci: string): PlayedMove | null {
    const legal = this.legalMoves();
    const move = legal.find((m) => m.uci === uci);
    if (!move || !this.rules.play(uci)) return null;
    const played = { uci, san: san(move, legal), from: move.from, to: move.to, rook: move.rook, castle: move.castle };
    this.moves.push(played);
    return played;
  }

  undo(): PlayedMove | null {
    if (!this.moves.length) return null;
    this.sync().undo();
    return this.moves.pop()!;
  }
}
