// A game against the engine: whose turn it is, engine moves, clocks, undo, hint, evaluation,
// the star, resignation and saving. Lives as long as the app; the Play screen renders it.
import { bookMove, record } from "../book/book.ts";
import { Game, START_FEN } from "../chess/game.ts";
import type { GameState, Rules } from "../chess/rules.ts";
import { san } from "../chess/san.ts";
import type { Engine, SearchInfo, SearchLimits } from "../engine/engine.ts";
import { load, save } from "../storage.ts";
import { movesBetween } from "../ui/move-input.ts";
import { Clocks, type ClockState, type Side, type TimeControl } from "./clocks.ts";

export interface GameSetup {
  startFen: string;
  chess960: boolean;
  /** Chess960 starting position number, if the game started from one. */
  position960?: number;
  human: Side;
  tc: TimeControl;
}

export type StarLoss = "undo" | "hint" | "evaluation" | "analysis" | "time";

interface Saved {
  setup: GameSetup;
  moves: string[];
  clocks?: ClockState;
  star: StarLoss | null;
  result: string | null;
  lowScores: number;
}

const SAVE_KEY = "current-game";
const HELP_TIME_MS = 2000; // search time for hint and evaluation
const RESIGN_CP = -1000; // the engine resigns at -10 pawns or worse ...
const RESIGN_MOVES = 4; // ... on this many of its moves in a row
const BOOK_DELAY_MS = 300; // a book move is played after this pause, so both moves can be seen

export const DEFAULT_SETUP: GameSetup = {
  startFen: START_FEN,
  chess960: false,
  human: "w",
  tc: { kind: "game", minutes: 10, increment: 5 },
};

const DRAW_TEXT: Partial<Record<GameState, string>> = {
  stalemate: "Draw by stalemate.",
  threefold: "Draw by threefold repetition.",
  fifty: "Draw by the fifty-move rule.",
  material: "Draw by insufficient material.",
};

/** Score text from White's point of view: "+0.35", "-1.20", "#3", "-#2". */
export function formatScore(info: SearchInfo, whiteToMove: boolean): string {
  const sign = whiteToMove ? 1 : -1;
  if ("mate" in info.score) {
    const m = info.score.mate * sign;
    return (m < 0 ? "-#" : "#") + Math.abs(m);
  }
  const cp = info.score.cp * sign;
  return (cp > 0 ? "+" : cp < 0 ? "-" : "") + (Math.abs(cp) / 100).toFixed(2);
}

export class PlayController {
  setup: GameSetup = DEFAULT_SETUP;
  game: Game;
  clocks: Clocks | null = null;
  star: StarLoss | null = null;
  result: string | null = null;
  thinking = false;
  hint: { from: number; to: number; san: string } | null = null;
  evaluation: string | null = null;
  helping: "hint" | "evaluation" | null = null;
  premove: [number, number] | null = null;
  /** The engine's last move came from the opening book. */
  bookMove = false;
  engine: Engine | null = null;
  private rules: Rules;
  private lowScores = 0;
  private active = false;
  private token = 0; // invalidates results of searches started before the latest change
  private listeners = new Set<() => void>();

  constructor(rules: Rules) {
    this.rules = rules;
    this.game = new Game(rules);
  }

  /** Restores the saved game, if any. */
  async restore(): Promise<void> {
    const saved = await load<Saved>(SAVE_KEY);
    if (!saved) {
      this.start(DEFAULT_SETUP);
      return;
    }
    this.setup = saved.setup;
    this.game = new Game(this.rules, saved.setup.startFen, saved.setup.chess960);
    for (const m of saved.moves) this.game.play(m);
    this.clocks = saved.setup.tc.kind === "move" ? null : new Clocks(saved.setup.tc, saved.clocks);
    this.star = saved.star;
    this.result = saved.result;
    this.lowScores = saved.lowScores;
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-renders views (for state kept outside the controller, e.g. engine loading). */
  refresh(): void {
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private persist(): void {
    save(SAVE_KEY, {
      setup: this.setup,
      moves: this.game.moves.map((m) => m.uci),
      clocks: this.clocks?.snapshot(),
      star: this.star,
      result: this.result,
      lowScores: this.lowScores,
    } satisfies Saved);
  }

  get humanToMove(): boolean {
    return this.game.turn() === this.setup.human;
  }

  get engineSide(): Side {
    return this.setup.human === "w" ? "b" : "w";
  }

  attachEngine(engine: Engine): void {
    this.engine = engine;
    if (this.active) this.continueGame();
    this.emit();
  }

  /** The Play screen is shown: clocks run, the engine thinks when it is its turn. */
  activate(): void {
    this.active = true;
    this.continueGame();
  }

  /** The Play screen is left: clocks stop, a running search is abandoned. */
  deactivate(): void {
    this.active = false;
    this.clocks?.pause();
    this.abandonSearch();
    this.persist();
  }

  /** Opening Analysis during a game costs the star. */
  analysisOpened(): void {
    if (!this.result) this.loseStar("analysis");
  }

  start(setup: GameSetup): void {
    this.abandonSearch();
    this.setup = setup;
    this.game = new Game(this.rules, setup.startFen, setup.chess960);
    this.clocks = setup.tc.kind === "move" ? null : new Clocks(setup.tc);
    this.star = null;
    this.result = null;
    this.lowScores = 0;
    this.premove = null;
    this.clearHelp();
    this.engine?.newGame();
    this.persist();
    this.emit();
    if (this.active) this.continueGame();
  }

  private continueGame(): void {
    if (this.result) return;
    const turn = this.game.turn();
    this.clocks?.start(turn);
    if (turn === this.engineSide) this.engineMove();
    this.emit();
  }

  private abandonSearch(): void {
    this.token++;
    this.thinking = false;
    this.helping = null;
    this.engine?.stop();
  }

  private clearHelp(): void {
    this.hint = null;
    this.evaluation = null;
  }

  private loseStar(reason: StarLoss): void {
    if (this.star) return;
    this.star = reason;
    this.persist();
    this.emit();
  }

  /** Called regularly by the screen: notices when the player's time has run out. */
  tick(): void {
    const c = this.clocks;
    if (c && !this.result && c.remaining(this.setup.human) < 0) this.loseStar("time");
  }

  humanMove(uci: string): boolean {
    if (this.result || !this.humanToMove) return false;
    const played = this.game.play(uci);
    if (!played) return false;
    this.token++; // a hint or evaluation still running is no longer wanted
    this.helping = null;
    this.clearHelp();
    this.bookMove = false;
    this.clocks?.moveMade(this.setup.human);
    this.checkEnd();
    this.persist();
    this.emit();
    if (!this.result && this.active) this.engineMove();
    return true;
  }

  setPremove(premove: [number, number] | null): void {
    this.premove = premove;
  }

  private async engineMove(): Promise<void> {
    const engine = this.engine;
    if (!engine) return; // starts when the engine has loaded (attachEngine)
    const token = ++this.token;
    this.thinking = true;
    this.bookMove = false;
    this.emit();
    // The book's move is used if it was searched at least as deeply as this search would be.
    const fromBook = engine.nps ? await bookMove(this.game, (engine.nps * this.budgetMs()) / 1000) : null;
    if (token !== this.token) return;
    let uci: string | null;
    let info: SearchInfo | null = null;
    if (fromBook) {
      await new Promise((r) => setTimeout(r, BOOK_DELAY_MS));
      if (token !== this.token) return;
      uci = fromBook;
    } else {
      const result = await engine.search(this.position(), this.limits());
      if (token !== this.token) return;
      record(this.game, result, engine, "game");
      uci = result.bestmove;
      info = result.info;
    }
    this.thinking = false;
    if (!uci || !this.game.play(uci)) {
      this.emit();
      return;
    }
    this.bookMove = !!fromBook;
    this.clocks?.moveMade(this.engineSide);
    if (info) {
      const lost = "mate" in info.score ? info.score.mate < 0 : info.score.cp <= RESIGN_CP;
      this.lowScores = lost ? this.lowScores + 1 : 0;
    }
    this.checkEnd();
    if (!this.result && this.lowScores >= RESIGN_MOVES) this.finish("The engine resigns. You win.");
    this.persist();
    this.emit();
    this.playPremove();
  }

  /** The time the engine will plan for this move (its own formula, see init_time in search.c). */
  private budgetMs(): number {
    const tc = this.setup.tc;
    if (tc.kind === "move" || !this.clocks) return tc.kind === "move" ? tc.seconds * 1000 : 1000;
    const c = this.clocks;
    const avail = Math.max(1, c.remaining(this.engineSide));
    const mtg = c.movesToGo(this.engineSide);
    return (mtg ? avail / (mtg + 1) : avail / 25) + (c.increment * 3) / 4;
  }

  private playPremove(): void {
    const pm = this.premove;
    this.premove = null;
    if (!pm || this.result) return;
    const moves = movesBetween(this.game.legalMoves(), pm[0], pm[1]);
    const move = moves.find((m) => !m.promo || m.promo === "q");
    if (move) this.humanMove(move.uci);
    else this.emit();
  }

  private position() {
    return { startFen: this.setup.startFen, moves: this.game.moves.map((m) => m.uci), chess960: this.setup.chess960 };
  }

  private limits(): SearchLimits {
    const tc = this.setup.tc;
    if (tc.kind === "move" || !this.clocks) return { movetime: tc.kind === "move" ? tc.seconds * 1000 : 1000 };
    const c = this.clocks;
    return {
      wtime: Math.max(1, c.remaining("w")),
      btime: Math.max(1, c.remaining("b")),
      winc: c.increment,
      binc: c.increment,
      movestogo: c.movesToGo(this.engineSide),
    };
  }

  private checkEnd(): void {
    const state = this.game.state();
    if (state === "ongoing") return;
    if (state === "checkmate") {
      const loser = this.game.turn();
      this.finish(loser === this.setup.human ? "Checkmate. The engine wins." : "Checkmate. You win.");
    } else this.finish(DRAW_TEXT[state]!);
  }

  private finish(text: string): void {
    this.result = text;
    this.clocks?.pause();
    this.premove = null;
  }

  /** Can the player take back a move? */
  get canUndo(): boolean {
    const humanStarts = this.game.startFen.split(" ")[1] === this.setup.human;
    return this.game.moves.length > (humanStarts ? 0 : 1);
  }

  /** Takes back moves until it is the player's turn again, with at least one of their moves undone. */
  undo(): void {
    if (!this.canUndo) return;
    this.abandonSearch();
    let humanUndone = false;
    while (this.game.moves.length && (!humanUndone || !this.humanToMove)) {
      this.game.undo();
      if (this.humanToMove) humanUndone = true;
    }
    this.result = null;
    this.lowScores = 0;
    this.premove = null;
    this.clearHelp();
    this.loseStar("undo");
    if (this.active) this.clocks?.start(this.setup.human);
    this.persist();
    this.emit();
  }

  /** Best move for the player, shown as an arrow. */
  requestHint(): void {
    this.help("hint");
  }

  /** Engine evaluation of the current position. */
  requestEvaluation(): void {
    this.help("evaluation");
  }

  private async help(kind: "hint" | "evaluation"): Promise<void> {
    const engine = this.engine;
    if (!engine || this.result || !this.humanToMove || this.helping) return;
    this.loseStar(kind);
    const token = ++this.token;
    this.clearHelp(); // a new request replaces the previous hint or evaluation
    this.helping = kind;
    this.emit();
    const result = await engine.search(this.position(), { movetime: HELP_TIME_MS });
    if (token !== this.token) return;
    record(this.game, result, engine, "game");
    this.helping = null;
    if (kind === "hint" && result.bestmove) {
      const legal = this.game.legalMoves();
      const move = legal.find((m) => m.uci === result.bestmove);
      if (move) this.hint = { from: move.from, to: move.castle ? move.rook : move.to, san: san(move, legal) };
    } else if (kind === "evaluation" && result.info) {
      this.evaluation = `${formatScore(result.info, this.game.turn() === "w")}, depth ${result.info.depth}`;
    }
    this.emit();
  }
}
