// The new-game sheet: opponent, variant, colour, time control. The last choices are remembered.
import { chess960Fen, randomChess960 } from "../chess/chess960.ts";
import { START_FEN } from "../chess/game.ts";
import { load, save } from "../storage.ts";
import type { TimeControl } from "./clocks.ts";
import type { GameSetup } from "./controller.ts";

interface Choices {
  /** "engine" (Dark C. Helmet) or a human-like profile ("human-1300"). */
  opponent: string;
  variant: "standard" | "chess960";
  start960: "random" | "number";
  number960: number;
  color: "w" | "random" | "b";
  /** Standard chess: the engine's book moves varied, or always the strongest. */
  openings: "varied" | "strongest";
  tcKind: "move" | "game" | "increment" | "classical";
  seconds: number;
  minutes: number;
  incMinutes: number;
  incSeconds: number;
  /** Chess960 with a clock: extra seconds for the player's first move. */
  extraSeconds: number;
}

const DEFAULTS: Choices = {
  opponent: "engine",
  variant: "standard",
  start960: "random",
  number960: 518,
  color: "w",
  openings: "varied",
  tcKind: "increment",
  seconds: 10,
  minutes: 5,
  incMinutes: 10,
  incSeconds: 5,
  extraSeconds: 30,
};

const PREFS_KEY = "new-game-choices";

function segmented(name: string, options: [string, string][], value: string): string {
  return `<div class="segmented" role="radiogroup">${options
    .map(
      ([v, label]) =>
        `<label><input type="radio" name="${name}" value="${v}"${v === value ? " checked" : ""}>${label}</label>`,
    )
    .join("")}</div>`;
}

/** Shows the sheet. Resolves to the new game's setup, or null if cancelled. With `position`
 *  (from the Setup screen) the variant choice is left out. */
export async function chooseNewGame(position?: { startFen: string; chess960: boolean }): Promise<GameSetup | null> {
  const c: Choices = { ...DEFAULTS, ...(await load<Partial<Choices>>(PREFS_KEY)) };
  const dialog = document.createElement("dialog");
  dialog.className = "sheet";
  dialog.setAttribute("aria-label", "New game");
  dialog.innerHTML = `
    <form class="sheet-body" method="dialog">
      <h2 class="title">New game</h2>
      <div class="field" data-show="opponent">
        <span class="field-label">Opponent</span>
        ${segmented("opponent", [["engine", "Dark C. Helmet"], ["human-1300", "1300 Elo player"], ["human-1600", "1600 Elo player"]], c.opponent)}
      </div>
      <div class="field" data-show="variant">
        <span class="field-label">Variant</span>
        ${segmented("variant", [["standard", "Standard"], ["chess960", "Chess960"]], c.variant)}
      </div>
      <div class="field-row" data-show="chess960">
        <div class="field">
          <span class="field-label">Start position</span>
          ${segmented("start960", [["random", "Random"], ["number", "Number"]], c.start960)}
        </div>
        <label class="field" data-show="number960">
          <span class="field-label">Number (0–959)</span>
          <input type="number" name="number960" min="0" max="959" value="${c.number960}">
        </label>
      </div>
      <div class="field">
        <span class="field-label">You play</span>
        ${segmented("color", [["w", "White"], ["random", "Random"], ["b", "Black"]], c.color)}
      </div>
      <div class="field" data-show="openings">
        <span class="field-label">Engine's openings</span>
        ${segmented("openings", [["varied", "Varied"], ["strongest", "Strongest"]], c.openings)}
      </div>
      <label class="field">
        <span class="field-label">Time control</span>
        <select name="tcKind">
          <option value="move"${c.tcKind === "move" ? " selected" : ""}>Time per engine move</option>
          <option value="game"${c.tcKind === "game" ? " selected" : ""}>Minutes per game</option>
          <option value="increment"${c.tcKind === "increment" ? " selected" : ""}>Minutes per game + increment</option>
          <option value="classical"${c.tcKind === "classical" ? " selected" : ""}>Classical (FIDE)</option>
        </select>
      </label>
      <label class="field" data-show="move">
        <span class="field-label">Seconds per engine move (you have no clock)</span>
        <input type="number" name="seconds" min="1" max="3600" value="${c.seconds}">
      </label>
      <label class="field" data-show="game">
        <span class="field-label">Minutes per player</span>
        <input type="number" name="minutes" min="1" max="600" value="${c.minutes}">
      </label>
      <div class="field-row" data-show="increment">
        <label class="field">
          <span class="field-label">Minutes per player</span>
          <input type="number" name="incMinutes" min="1" max="600" value="${c.incMinutes}">
        </label>
        <label class="field">
          <span class="field-label">Seconds added per move</span>
          <input type="number" name="incSeconds" min="0" max="600" value="${c.incSeconds}">
        </label>
      </div>
      <p class="small muted" data-show="classical">90 minutes for the first 40 moves, then 30 minutes for the rest
        of the game, with 30 seconds added per move from move 1.</p>
      <label class="field" data-show="extra">
        <span class="field-label">Extra seconds for your first move</span>
        <input type="number" name="extraSeconds" min="0" max="600" value="${c.extraSeconds}">
      </label>
      <div class="sheet-actions">
        <button type="button" class="btn-secondary" value="cancel">Cancel</button>
        <button type="submit" class="btn-primary" value="start">Start game</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector("form")!;

  const read = (): Choices => {
    const d = new FormData(form);
    const n = (k: keyof Choices, min: number, max: number) => {
      const v = Math.round(Number(d.get(k)));
      return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : (DEFAULTS[k] as number);
    };
    return {
      opponent: (d.get("opponent") ?? "engine") as string,
      variant: d.get("variant") as Choices["variant"],
      start960: d.get("start960") as Choices["start960"],
      number960: n("number960", 0, 959),
      color: d.get("color") as Choices["color"],
      openings: (d.get("openings") ?? "varied") as Choices["openings"],
      tcKind: d.get("tcKind") as Choices["tcKind"],
      seconds: n("seconds", 1, 3600),
      minutes: n("minutes", 1, 600),
      incMinutes: n("incMinutes", 1, 600),
      incSeconds: n("incSeconds", 0, 600),
      extraSeconds: n("extraSeconds", 0, 600),
    };
  };
  const update = () => {
    const r = read();
    // The human-like player learned from standard games only.
    const human = r.opponent !== "engine";
    const visible: Record<string, boolean> = {
      opponent: !position?.chess960,
      variant: !position && !human,
      // The book's choice matters in standard chess; Chess960 games are out of book at once.
      openings: !position && !human && r.variant === "standard",
      chess960: !position && !human && r.variant === "chess960",
      number960: r.start960 === "number",
      move: r.tcKind === "move",
      game: r.tcKind === "game",
      increment: r.tcKind === "increment",
      classical: r.tcKind === "classical",
      // Chess960 with a clock: time to look at the starting position.
      extra: (position ? position.chess960 : !human && r.variant === "chess960") && r.tcKind !== "move",
    };
    for (const el of form.querySelectorAll<HTMLElement>("[data-show]")) el.hidden = !visible[el.dataset.show!];
  };
  form.addEventListener("change", update);
  update();

  return new Promise((resolve) => {
    let result: GameSetup | null = null;
    form.querySelector<HTMLButtonElement>('[value="cancel"]')!.addEventListener("click", () => dialog.close());
    form.addEventListener("submit", () => {
      const r = read();
      save(PREFS_KEY, r);
      const tc: TimeControl =
        r.tcKind === "move"
          ? { kind: "move", seconds: r.seconds }
          : r.tcKind === "game"
            ? { kind: "game", minutes: r.minutes, increment: 0 }
            : r.tcKind === "increment"
              ? { kind: "game", minutes: r.incMinutes, increment: r.incSeconds }
              : { kind: "classical" };
      const human = r.color === "random" ? (Math.random() < 0.5 ? "w" : "b") : r.color;
      const humanProfile = r.opponent.startsWith("human-") && !position?.chess960 ? r.opponent.slice(6) : undefined;
      if (position) {
        result = { ...position, human, tc, humanProfile, firstMoveExtra: position.chess960 && tc.kind !== "move" ? r.extraSeconds : 0 };
      } else if (humanProfile) {
        result = { startFen: START_FEN, chess960: false, human, tc, humanProfile };
      } else if (r.variant === "chess960") {
        const n = r.start960 === "random" ? randomChess960() : r.number960;
        const firstMoveExtra = tc.kind !== "move" ? r.extraSeconds : 0;
        result = { startFen: chess960Fen(n), chess960: true, position960: n, human, tc, firstMoveExtra };
      } else {
        result = { startFen: START_FEN, chess960: false, human, tc, strongestOpenings: r.openings === "strongest" };
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    dialog.showModal();
  });
}
