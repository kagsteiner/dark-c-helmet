// Time controls and the game clocks.

export type TimeControl =
  /** Fixed time per engine move; the player has no clock. */
  | { kind: "move"; seconds: number }
  /** Minutes per game plus an increment per move (0: sudden death). */
  | { kind: "game"; minutes: number; increment: number }
  /** FIDE classical: 90 min for 40 moves, then 30 min for the rest, 30 s per move from move 1. */
  | { kind: "classical" };

export const CLASSICAL = { minutes: 90, moves: 40, bonusMinutes: 30, increment: 30 };

export function describeTimeControl(tc: TimeControl): string {
  if (tc.kind === "move") return `${tc.seconds} s per move`;
  if (tc.kind === "classical") return "90 min / 40 moves + 30 min, +30 s";
  return tc.increment ? `${tc.minutes} + ${tc.increment}` : `${tc.minutes} min`;
}

export type Side = "w" | "b";

export interface ClockState {
  /** Remaining milliseconds; negative once a player has overstepped. */
  remaining: Record<Side, number>;
  /** Moves completed by each side (for the 40-move control). */
  moves: Record<Side, number>;
  /** Extra time left for a side's first move (ms): used up before its clock runs, not added
   *  to it (Chess960: time to look at the starting position). */
  extra?: Record<Side, number>;
}

/** Clocks for "game" and "classical" time controls. Time is measured with performance.now(). */
export class Clocks {
  readonly tc: Exclude<TimeControl, { kind: "move" }>;
  private state: ClockState;
  private running: Side | null = null;
  private since = 0;
  private now: () => number;

  /** `extra`: extra time for one side's first move (new games only; a saved state has its own). */
  constructor(
    tc: Exclude<TimeControl, { kind: "move" }>,
    state?: ClockState,
    now = () => performance.now(),
    extra?: { side: Side; ms: number },
  ) {
    this.tc = tc;
    this.now = now;
    const start = (tc.kind === "classical" ? CLASSICAL.minutes : tc.minutes) * 60_000;
    this.state = state ?? { remaining: { w: start, b: start }, moves: { w: 0, b: 0 } };
    if (!state && extra && extra.ms > 0) this.state.extra = { w: 0, b: 0, [extra.side]: extra.ms };
  }

  get increment(): number {
    return (this.tc.kind === "classical" ? CLASSICAL.increment : this.tc.increment) * 1000;
  }

  /** Remaining time of a side, including the running period (after any first-move extra). */
  remaining(side: Side): number {
    const r = this.state.remaining[side];
    if (side !== this.running) return r;
    return r - Math.max(0, this.now() - this.since - (this.state.extra?.[side] ?? 0));
  }

  /** First-move extra time a side still has (ms); 0 when there is none. */
  extraLeft(side: Side): number {
    const e = this.state.extra?.[side] ?? 0;
    return side === this.running ? Math.max(0, e - (this.now() - this.since)) : e;
  }

  runningSide(): Side | null {
    return this.running;
  }

  start(side: Side): void {
    this.pause();
    this.running = side;
    this.since = this.now();
  }

  /** Stops the clock without ending the move (screen left, analysis opened). */
  pause(): void {
    const side = this.running;
    if (side) {
      this.state.remaining[side] = this.remaining(side);
      if (this.state.extra) this.state.extra[side] = this.extraLeft(side);
    }
    this.running = null;
  }

  /** The side to move completed its move: stop its clock, add the increment and, after the
   *  40th move in classical, the extra time; then start the opponent's clock. */
  moveMade(side: Side): void {
    this.pause();
    if (this.state.extra) this.state.extra[side] = 0; // only for the first move
    this.state.moves[side]++;
    this.state.remaining[side] += this.increment;
    if (this.tc.kind === "classical" && this.state.moves[side] === CLASSICAL.moves) {
      this.state.remaining[side] += CLASSICAL.bonusMinutes * 60_000;
    }
    this.start(side === "w" ? "b" : "w");
  }

  /** Moves left until the next time control, for the engine ("movestogo"). */
  movesToGo(side: Side): number | undefined {
    if (this.tc.kind !== "classical") return undefined;
    const done = this.state.moves[side];
    return done < CLASSICAL.moves ? CLASSICAL.moves - done : undefined;
  }

  snapshot(): ClockState {
    const s = structuredClone(this.state);
    if (this.running) {
      s.remaining[this.running] = this.remaining(this.running);
      if (s.extra) s.extra[this.running] = this.extraLeft(this.running);
    }
    return s;
  }
}

/** m:ss, h:mm:ss from an hour, tenths below 10 seconds; "-" when overstepped. */
export function formatClock(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  if (abs < 10_000 && ms >= 0) return (Math.floor(abs / 100) / 10).toFixed(1);
  const total = Math.floor(abs / 1000);
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  const ss = String(s).padStart(2, "0");
  return sign + (h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`);
}
