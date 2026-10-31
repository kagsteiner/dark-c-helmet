// The new-game sheet: variant, colour, time control. The last choices are remembered.
import { chess960Fen, randomChess960 } from "../chess/chess960.ts";
import { START_FEN } from "../chess/game.ts";
import { load, save } from "../storage.ts";
import type { TimeControl } from "./clocks.ts";
import type { GameSetup } from "./controller.ts";

interface Choices {
  variant: "standard" | "chess960";
  start960: "random" | "number";
  number960: number;
  color: "w" | "random" | "b";
  tcKind: "move" | "game" | "increment" | "classical";
  seconds: number;
  minutes: number;
  incMinutes: number;
  incSeconds: number;
}

const DEFAULTS: Choices = {
  variant: "standard",
  start960: "random",
  number960: 518,
  color: "w",
  tcKind: "increment",
  seconds: 10,
  minutes: 5,
  incMinutes: 10,
  incSeconds: 5,
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
      variant: d.get("variant") as Choices["variant"],
      start960: d.get("start960") as Choices["start960"],
      number960: n("number960", 0, 959),
      color: d.get("color") as Choices["color"],
      tcKind: d.get("tcKind") as Choices["tcKind"],
      seconds: n("seconds", 1, 3600),
      minutes: n("minutes", 1, 600),
      incMinutes: n("incMinutes", 1, 600),
      incSeconds: n("incSeconds", 0, 600),
    };
  };
  const update = () => {
    const r = read();
    const visible: Record<string, boolean> = {
      variant: !position,
      chess960: !position && r.variant === "chess960",
      number960: r.start960 === "number",
      move: r.tcKind === "move",
      game: r.tcKind === "game",
      increment: r.tcKind === "increment",
      classical: r.tcKind === "classical",
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
      if (position) {
        result = { ...position, human, tc };
      } else if (r.variant === "chess960") {
        const n = r.start960 === "random" ? randomChess960() : r.number960;
        result = { startFen: chess960Fen(n), chess960: true, position960: n, human, tc };
      } else {
        result = { startFen: START_FEN, chess960: false, human, tc };
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    dialog.showModal();
  });
}
