// Chess rules for the UI: the engine's own move generator, compiled as a small WebAssembly
// module (engine/rules_api.c). Calls are synchronous. One game at a time: a start position
// plus the moves played (needed for threefold repetition).

export interface LegalMove {
  /** As the engine reads it; Chess960 castling is written king-takes-own-rook. */
  uci: string;
  /** Squares 0-63, a1 = 0. For castling, `to` is the king's target square. */
  from: number;
  to: number;
  /** Castling only: the rook's start square, otherwise -1. */
  rook: number;
  piece: "P" | "N" | "B" | "R" | "Q" | "K";
  capture: boolean;
  promo: "" | "n" | "b" | "r" | "q";
  castle: boolean;
  check: boolean;
  mate: boolean;
}

export type GameState = "ongoing" | "checkmate" | "stalemate" | "threefold" | "fifty" | "material";
const STATES: GameState[] = ["ongoing", "checkmate", "stalemate", "threefold", "fifty", "material"];

interface RulesModule {
  ccall(name: string, returnType: "number" | "string" | null, argTypes: string[], args: unknown[]): unknown;
}

type RawMove = Omit<LegalMove, "capture" | "castle" | "check" | "mate"> & {
  capture: number;
  castle: number;
  check: number;
  mate: number;
};

export class Rules {
  private constructor(private m: RulesModule) {}

  static async load(): Promise<Rules> {
    const dir = new URL("engine/", new URL(import.meta.env.BASE_URL, location.href)).href;
    const factory = (await import(/* @vite-ignore */ dir + "dh-rules.js")).default as (options: {
      locateFile: (path: string) => string;
    }) => Promise<RulesModule>;
    const m = await factory({ locateFile: (path) => dir + path });
    m.ccall("rules_init", null, [], []);
    return new Rules(m);
  }

  /** Starts a new game from this position. Returns false if the FEN is not valid. */
  setFen(fen: string, chess960: boolean): boolean {
    return this.m.ccall("rules_set_fen", "number", ["string", "number"], [fen, chess960 ? 1 : 0]) === 1;
  }

  fen(): string {
    return this.m.ccall("rules_fen", "string", [], []) as string;
  }

  /** Plays a move (UCI notation). Returns false if it is not legal. */
  play(uci: string): boolean {
    return this.m.ccall("rules_play", "number", ["string"], [uci]) === 1;
  }

  /** Takes back the last move. Returns false if there is none. */
  undo(): boolean {
    return this.m.ccall("rules_undo", "number", [], []) === 1;
  }

  state(): GameState {
    return STATES[this.m.ccall("rules_state", "number", [], []) as number];
  }

  inCheck(): boolean {
    return this.m.ccall("rules_in_check", "number", [], []) === 1;
  }

  moves(): LegalMove[] {
    const raw = JSON.parse(this.m.ccall("rules_moves", "string", [], []) as string) as RawMove[];
    return raw.map((r) => ({
      ...r,
      capture: r.capture === 1,
      castle: r.castle === 1,
      check: r.check === 1,
      mate: r.mate === 1,
    }));
  }

  perft(depth: number): number {
    return this.m.ccall("rules_perft", "number", ["number"], [depth]) as number;
  }
}
