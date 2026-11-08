// The new-game sheet: opponent, variant, colour, time control. The last choices are remembered.
import { backRank, chess960SquaredFen, randomChess960 } from "../chess/chess960.ts";
import type { PieceCode } from "../chess/fen.ts";
import { START_FEN } from "../chess/game.ts";
import { load, save } from "../storage.ts";
import { pieceUrl } from "../ui/board.ts";
import { icons } from "../ui/icons.ts";
import { randomBalancedPair } from "./balanced.ts";
import { bookmarkDate, loadBookmarks, removeBookmark, setBookmarkNote, startName, type Bookmark } from "./bookmarks.ts";
import type { TimeControl } from "./clocks.ts";
import type { GameSetup } from "./controller.ts";

export interface Choices {
  /** "engine" (Dark C. Helmet) or a human-like profile ("human-1300"). */
  opponent: string;
  /** "chess960sq": Chess 960², each side its own back rank. */
  variant: "standard" | "chess960" | "chess960sq";
  start960: "random" | "number" | "bookmark";
  number960: number;
  /** Chess 960² by number. */
  whiteNumber: number;
  blackNumber: number;
  /** The chosen bookmark as "white-black". */
  bookmark: string;
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
  whiteNumber: 518,
  blackNumber: 518,
  bookmark: "",
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

/** A back rank as piece images: White's, or Black's when `black`. */
function rankImages(n: number, black: boolean): string {
  const rank = black ? backRank(n).toLowerCase() : backRank(n);
  return `<span class="bm-rank">${[...rank].map((p) => `<img src="${pieceUrl(p as PieceCode)}" alt="">`).join("")}</span>`;
}

/** One row of the bookmark list; the note is filled in afterwards, as plain text. */
function bookmarkRow(b: Bookmark, selected: string): string {
  const v = `${b.white}-${b.black}`;
  const name = startName(b.white, b.black);
  return `<div class="bm-row" data-start="${v}" data-squared="${b.white !== b.black ? 1 : 0}">
      <label class="bm-pick">
        <input type="radio" name="bookmark" value="${v}"${v === selected ? " checked" : ""}>
        <span class="bm-ranks">${b.white !== b.black ? rankImages(b.black, true) : ""}${rankImages(b.white, false)}</span>
        <span class="bm-text"><span>${name}</span><span class="small muted">${bookmarkDate(b.added)}</span></span>
      </label>
      <button type="button" class="btn-icon bm-delete" aria-label="Delete bookmark ${name}" title="Delete bookmark">${icons.close}</button>
      <input class="bm-note" type="text" maxlength="100" placeholder="Add a note" aria-label="Note for ${name}">
    </div>`;
}

function segmented(name: string, options: [string, string][], value: string): string {
  return `<div class="segmented" role="radiogroup">${options
    .map(
      ([v, label]) =>
        `<label><input type="radio" name="${name}" value="${v}"${v === value ? " checked" : ""}>${label}</label>`,
    )
    .join("")}</div>`;
}

/** Shows the sheet. Resolves to the new game's setup, or null if cancelled. With `position`
 *  (from the Setup screen) the variant choice is left out. `preset` overrides the remembered
 *  choices (from the Progress screen). */
export async function chooseNewGame(
  position?: { startFen: string; chess960: boolean },
  preset?: Partial<Choices>,
): Promise<GameSetup | null> {
  const c: Choices = { ...DEFAULTS, ...(await load<Partial<Choices>>(PREFS_KEY)), ...preset };
  const bookmarks = await loadBookmarks();
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
        ${segmented("variant", [["standard", "Standard"], ["chess960", "Chess960"], ["chess960sq", "960²"]], c.variant)}
      </div>
      <p class="small muted" data-show="squaredInfo">Chess 960²: White and Black each start from their own Chess960
        position. Castling works as in Chess960, with each side's own rooks.</p>
      <div class="field" data-show="startChoice">
        <span class="field-label">Start position</span>
        ${segmented("start960", [["random", "Random"], ["number", "Number"], ["bookmark", "Bookmark"]], c.start960)}
      </div>
      <label class="field" data-show="number960">
        <span class="field-label">Number (0–959)</span>
        <input type="number" name="number960" min="0" max="959" value="${c.number960}">
      </label>
      <div class="field-row" data-show="numbers960sq">
        <label class="field">
          <span class="field-label">White's number</span>
          <input type="number" name="whiteNumber" min="0" max="959" value="${c.whiteNumber}">
        </label>
        <label class="field">
          <span class="field-label">Black's number</span>
          <input type="number" name="blackNumber" min="0" max="959" value="${c.blackNumber}">
        </label>
      </div>
      <div class="field" data-show="bookmarks">
        <span class="field-label">Bookmark</span>
        <div class="bm-list">${bookmarks.map((b) => bookmarkRow(b, c.bookmark)).join("")}</div>
        <p class="small muted bm-empty" hidden></p>
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
    const variant = (d.get("variant") ?? c.variant) as Choices["variant"];
    return {
      opponent: (d.get("opponent") ?? "engine") as string,
      variant,
      start960: d.get("start960") as Choices["start960"],
      number960: n("number960", 0, 959),
      whiteNumber: n("whiteNumber", 0, 959),
      blackNumber: n("blackNumber", 0, 959),
      bookmark: String(d.get("bookmark") ?? ""),
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
  // The list shows the bookmarks of the chosen variant, always with one of them selected.
  const updateBookmarks = (squared: boolean): number => {
    const rows = [...form.querySelectorAll<HTMLElement>(".bm-row")];
    const visible = rows.filter((row) => {
      row.hidden = (row.dataset.squared === "1") !== squared;
      return !row.hidden;
    });
    for (const row of rows) if (row.hidden) row.querySelector<HTMLInputElement>("input[type=radio]")!.checked = false;
    if (visible.length && !visible.some((row) => row.querySelector<HTMLInputElement>("input[type=radio]")!.checked))
      visible[0].querySelector<HTMLInputElement>("input[type=radio]")!.checked = true;
    const empty = form.querySelector<HTMLElement>(".bm-empty")!;
    empty.hidden = visible.length > 0;
    empty.textContent = `No ${squared ? "Chess 960²" : "Chess960"} bookmarks yet. The bookmark button next to the star adds one during a game.`;
    return visible.length;
  };
  const update = () => {
    const squared = new FormData(form).get("variant") === "chess960sq";
    const bookmarkCount = updateBookmarks(squared);
    const r = read();
    // The human-like player has no opening book.
    const human = r.opponent !== "engine";
    const visible: Record<string, boolean> = {
      opponent: true,
      variant: !position,
      // The book's choice matters in standard chess; Chess960 games are out of book at once.
      openings: !position && !human && r.variant === "standard",
      startChoice: !position && r.variant !== "standard",
      squaredInfo: !position && r.variant === "chess960sq",
      number960: r.variant === "chess960" && r.start960 === "number",
      numbers960sq: !position && r.variant === "chess960sq" && r.start960 === "number",
      bookmarks: !position && r.variant !== "standard" && r.start960 === "bookmark",
      move: r.tcKind === "move",
      game: r.tcKind === "game",
      increment: r.tcKind === "increment",
      classical: r.tcKind === "classical",
      // Chess960 with a clock: time to look at the starting position.
      extra: (position ? position.chess960 : r.variant !== "standard") && r.tcKind !== "move",
    };
    for (const el of form.querySelectorAll<HTMLElement>("[data-show]")) el.hidden = !visible[el.dataset.show!];
    form.querySelector<HTMLButtonElement>('[value="start"]')!.disabled = visible.bookmarks && !bookmarkCount;
  };
  bookmarks.forEach((b) => {
    const row = form.querySelector<HTMLElement>(`.bm-row[data-start="${b.white}-${b.black}"]`)!;
    const note = row.querySelector<HTMLInputElement>(".bm-note")!;
    note.value = b.note ?? "";
    note.addEventListener("input", () => void setBookmarkNote(b.white, b.black, note.value));
    note.addEventListener("focus", () => (row.querySelector<HTMLInputElement>("input[type=radio]")!.checked = true));
    note.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault(); // Enter ends the note and does not start the game
      note.blur();
    });
    row.querySelector(".bm-delete")!.addEventListener("click", () => {
      void removeBookmark(b.white, b.black);
      row.remove();
      update();
    });
  });
  form.addEventListener("change", update);
  update();

  return new Promise((resolve) => {
    let result: GameSetup | null = null;
    let pending: Promise<void> | null = null;
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
      const humanProfile = r.opponent.startsWith("human-") ? r.opponent.slice(6) : undefined;
      if (position) {
        result = { ...position, human, tc, humanProfile, firstMoveExtra: position.chess960 && tc.kind !== "move" ? r.extraSeconds : 0 };
      } else if (r.variant !== "standard") {
        const squared = r.variant === "chess960sq";
        const firstMoveExtra = tc.kind !== "move" ? r.extraSeconds : 0;
        const start = (white: number, black: number) => {
          result = {
            startFen: chess960SquaredFen(white, black),
            chess960: true,
            position960: white,
            ...(squared ? { black960: black } : {}),
            human,
            tc,
            humanProfile,
            firstMoveExtra,
          };
        };
        const marked = r.bookmark.split("-").map(Number);
        if (r.start960 === "bookmark" && marked.length === 2 && marked.every(Number.isInteger)) start(marked[0], marked[1]);
        else if (squared && r.start960 === "number") start(r.whiteNumber, r.blackNumber);
        else if (squared) pending = randomBalancedPair().then(([w, b]) => start(w, b));
        else {
          const n = r.start960 === "number" ? r.number960 : randomChess960();
          start(n, n);
        }
      } else {
        result = { startFen: START_FEN, chess960: false, human, tc, humanProfile, strongestOpenings: !humanProfile && r.openings === "strongest" };
      }
    });
    dialog.addEventListener("close", async () => {
      dialog.remove();
      if (pending) await pending;
      resolve(result);
    });
    dialog.showModal();
  });
}
