// The Play screen: renders the PlayController's game and passes the player's input to it.
import { placementFromFen } from "../chess/fen.ts";
import { describeTimeControl, formatClock, formatSeconds, noClock, type Side } from "../play/clocks.ts";
import { opponentName, type PlayController, type StarLoss } from "../play/controller.ts";
import { isBookmarked, setBookmarkNote, startName, toggleBookmark } from "../play/bookmarks.ts";
import { ACHIEVEMENTS, earnedFrom, LEVELS, newIn, type Earned } from "../play/achievements.ts";
import { loadRecords } from "../play/history.ts";
import { reportText } from "../play/report.ts";
import { chooseNewGame } from "../play/new-game.ts";
import { balanceOf, formatPawns, STANDARD_START_CP, startScore } from "../play/start-balance.ts";
import { Board } from "../ui/board.ts";
import { openBoardThemePicker, openPickerIfRequested } from "../ui/board-theme-picker.ts";
import { icons } from "../ui/icons.ts";
import { MoveInput } from "../ui/move-input.ts";
import { settings } from "../settings.ts";
import type { Screen } from "../ui/shell.ts";
import "../styles/play.css";

/** How long an achievement pop-up stays (its CSS animation has the same length). */
const TOAST_MS = 4500;

const STAR_TEXT: Record<StarLoss | "lit", string> = {
  lit: "Clean game so far: no undo, no hints.",
  undo: "Star lost: you took back a move.",
  hint: "Star lost: you asked for a hint.",
  evaluation: "Star lost: you asked for an evaluation.",
  analysis: "Star lost: you opened the analysis.",
  time: "Silver star: your time ran out.",
};

export function playScreen(controller: PlayController, engineStatus: () => string | null): Screen {
  const board = new Board();

  return {
    mount(root) {
      root.innerHTML = `
        <section class="play">
          <div class="play-player play-top"><span class="player-name"></span><span class="clock numeric"></span></div>
          <div class="play-board"></div>
          <div class="play-player play-bottom"><span class="player-name"></span><span class="clock numeric"></span></div>
          <div class="play-moves">
            <p class="play-meta small muted"></p>
            <p class="play-balance small" hidden></p>
            <p class="play-report small" hidden title="Your report card: how long you held the position (engine's evaluation above −1.00 for you), your worst moment, and how often your analysis in the grid anticipated the engine's moves, how often you played the engine's choice for you"></p>
            <a class="play-toast small" href="#/achievements" role="status" hidden></a>
            <p class="play-achieved small" hidden></p>
            <ol class="move-list numeric" aria-label="Moves"></ol>
            <p class="play-status small muted" aria-live="polite"></p>
            <p class="play-help small" aria-live="polite"></p>
            <a class="play-think btn-primary" href="#/grid" hidden
              title="Your own analysis of this game in the analysis grid: locked, no engine. Your star stays.">Think in the grid</a>
          </div>
          <div class="play-actions">
            <button class="btn-icon play-undo" data-action="undo" aria-label="Take back" title="Take back">${icons.undo}</button>
            <button class="btn-icon" data-action="hint" aria-label="Hint" title="Hint">${icons.hint}</button>
            <button class="btn-icon" data-action="evaluation" aria-label="Evaluation" title="Evaluation">${icons.evaluation}</button>
            <button class="btn-icon star" data-action="star" aria-label="Star" title="Star"></button>
            <button class="btn-icon" data-action="bookmark" aria-label="Bookmark this start position" title="Bookmark this start position" aria-pressed="false" hidden></button>
            <button class="btn-icon" data-action="colors" aria-label="Board colours" title="Board colours">${icons.palette}</button>
            <span class="spacer"></span>
            <button class="btn-secondary" data-action="new">New game</button>
            <button class="btn-secondary" data-action="odds" title="Challenge Dark C. Helmet at full strength, with odds for you: less time for the engine, no clock for you, takebacks that keep the star. Earns achievements.">Challenge</button>
            <input class="bookmark-note" type="text" maxlength="100" placeholder="Add a note to this bookmark" aria-label="Note for this bookmark" hidden>
            <p class="star-tip small" role="status" hidden></p>
          </div>
        </section>`;
      const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
      $(".play-board").append(board.el);

      const input = new MoveInput(board, {
        onMove: (uci) => controller.humanMove(uci),
        targetOnly: () => settings().targetOnly,
        onPremove: (pm) => controller.setPremove(pm),
      });

      let shownFen = "";
      const render = () => {
        const c = controller;
        const game = c.game;
        const fen = game.fen();
        const placement = placementFromFen(fen);
        board.setOrientation(c.setup.human === "w" ? "white" : "black");
        if (fen !== shownFen) {
          board.setPlacement(placement, shownFen !== "");
          shownFen = fen;
        }
        const white = game.turn() === "w";
        const last = game.moves.at(-1);
        const humanTurn = c.humanToMove && !c.result;
        input.setPosition(placement, humanTurn ? game.legalMoves() : [], white, {
          lastMove: last ? [last.from, last.castle ? last.rook : last.to] : undefined,
          check: game.inCheck() ? placement.indexOf(white ? "K" : "k") : undefined,
        });
        input.setMode(c.result ? "off" : humanTurn ? "move" : "premove");
        board.setArrows(c.hint ? [{ from: c.hint.from, to: c.hint.to }] : []);

        const human = c.setup.human;
        $(".play-top .player-name").textContent = opponentName(c.setup);
        $(".play-bottom .player-name").textContent = human === "w" ? "You (White)" : "You (Black)";
        const tc = describeTimeControl(c.setup.tc);
        const { position960: wNo, black960: bNo } = c.setup;
        $(".play-meta").textContent =
          (bNo !== undefined && wNo !== undefined
            ? `Chess 960² · ${startName(wNo, bNo)} · `
            : c.setup.chess960
              ? `Chess960 no. ${wNo ?? "?"} · `
              : "") +
          (c.odds ? "Challenge: " : "") +
          tc +
          (c.odds ? ` · ${c.setup.takebacks ?? 0} takeback${c.setup.takebacks === 1 ? "" : "s"} with the star` : "") +
          (c.setup.strongestOpenings ? " · strongest openings" : "");
        // Games with odds: the report card so far.
        const report = $<HTMLElement>(".play-report");
        const card = c.odds ? reportText(c.report, c.evals.length > 0) : "";
        report.hidden = !card;
        report.textContent = card ? (c.result ? "Your report: " : "So far: ") + card : "";
        renderAchieved();
        renderMoves();
        renderClocks();
        renderBookmark();
        renderBalance();

        $(".play-status").textContent =
          engineStatus() ??
          c.result ??
          (c.helping === "hint"
            ? "Looking for a hint…"
            : c.helping === "evaluation"
              ? "Evaluating…"
              : c.thinking
                ? "The engine is thinking…"
                : humanTurn
                  ? c.bookMove
                    ? "Your move. The engine played a move from its book."
                    : c.bookTooShallow
                      ? "Your move. The book's analysis here is shallower than this time control, so the engine thought for itself."
                      : "Your move."
                  : "");
        $(".play-help").textContent = c.hint ? `Hint: ${c.hint.san}` : c.evaluation ? `Evaluation: ${c.evaluation}` : "";

        const helpAllowed = humanTurn && !!c.engine && !c.helping;
        const undo = $<HTMLButtonElement>('[data-action="undo"]');
        undo.disabled = !c.canUndo;
        // With odds: how many takebacks still keep the star.
        const left = c.takebacksLeft;
        if (left === null) delete undo.dataset.left;
        else undo.dataset.left = String(left);
        undo.title = left === null ? "Take back" : `Take back (${left} left that keep${left === 1 ? "s" : ""} the star)`;
        // Correspondence with odds: think it over in the analysis grid (locked) on your move.
        const think = $<HTMLAnchorElement>(".play-think");
        think.hidden = !(noClock(c.setup.tc) && humanTurn);
        think.href = `#/grid?game=${encodeURIComponent(c.gameId)}`;
        $<HTMLButtonElement>('[data-action="hint"]').disabled = !helpAllowed;
        $<HTMLButtonElement>('[data-action="evaluation"]').disabled = !helpAllowed;
        const star = $<HTMLButtonElement>('[data-action="star"]');
        const silver = c.star === "time";
        star.innerHTML = c.star && !silver ? icons.starOut : icons.starLit;
        star.classList.toggle("lit", !c.star || silver);
        star.classList.toggle("silver", silver);
        const tip = $<HTMLElement>(".star-tip");
        if (!tip.hidden) {
          tip.textContent = STAR_TEXT[c.star ?? "lit"];
          if (c.odds && !c.star) {
            const n = c.setup.takebacks ?? 0;
            tip.textContent = `Clean game within your odds: ${c.takebacksUsed} of ${n} takeback${n === 1 ? "" : "s"} used, no hints.`;
          } else if (c.odds && c.star === "undo") tip.textContent = "Star lost: you took back more moves than your odds allow.";
        }
      };

      // Chess960 and Chess 960²: one sentence on how balanced the start is, compared with normal
      // chess. A Chess960 start is the 960² pair with the same number on both sides.
      let balanceFor = "";
      const renderBalance = () => {
        const { chess960, position960: w } = controller.setup;
        const b = controller.setup.black960 ?? w;
        const key = chess960 && w !== undefined && b !== undefined ? `${w}-${b}` : "";
        if (key === balanceFor) return;
        balanceFor = key;
        const line = $<HTMLElement>(".play-balance");
        line.hidden = true;
        line.title = "";
        if (!key) return;
        startScore(w!, b!).then((cp) => {
          if (balanceFor !== key || cp === null) return;
          line.textContent = balanceOf(cp).sentence;
          line.title = `Engine score of this start: ${formatPawns(cp)} (normal chess: ${formatPawns(STANDARD_START_CP)})`;
          line.hidden = false;
        });
      };

      // The bookmark button: Chess960 and Chess 960² games from a numbered start.
      let bookmarkFor = "";
      let bookmarked = false;
      const startOf = () => {
        const { chess960, position960: w, black960: b } = controller.setup;
        return chess960 && w !== undefined ? { white: w, black: b ?? w } : null;
      };
      const paintBookmark = () => {
        const btn = $<HTMLButtonElement>('[data-action="bookmark"]');
        btn.innerHTML = bookmarked ? icons.bookmarked : icons.bookmark;
        btn.setAttribute("aria-pressed", String(bookmarked));
        btn.title = bookmarked ? "Bookmarked: tap to remove" : "Bookmark this start position";
      };
      const note = $<HTMLInputElement>(".bookmark-note");
      const hideNote = () => {
        note.hidden = true;
        note.value = "";
      };
      note.addEventListener("input", () => {
        const start = startOf();
        if (start) void setBookmarkNote(start.white, start.black, note.value);
      });
      note.addEventListener("keydown", (e) => {
        if (e.key === "Enter") note.blur();
      });
      const renderBookmark = () => {
        const start = startOf();
        const btn = $<HTMLButtonElement>('[data-action="bookmark"]');
        btn.hidden = !start;
        const key = start ? `${start.white}-${start.black}` : "";
        if (!start || key === bookmarkFor) return;
        bookmarkFor = key;
        bookmarked = false;
        hideNote();
        paintBookmark();
        isBookmarked(start.white, start.black).then((on) => {
          if (bookmarkFor !== key) return;
          bookmarked = on;
          paintBookmark();
        });
      };

      // The last engine-choice mark that flashed (a mark flashes only when its move is new).
      let flashedPly = Object.keys(controller.found).reduce((m, k) => Math.max(m, Number(k)), -1);
      // Games with odds: achievement levels this game has earned that earlier games had not.
      let earlier: { id: string; earned: Earned | null } | null = null;
      const renderAchieved = () => {
        const el = $<HTMLElement>(".play-achieved");
        el.hidden = !controller.odds;
        if (!controller.odds) return;
        const id = controller.gameId;
        if (earlier?.id !== id) {
          earlier = { id, earned: null }; // until loaded, nothing counts as new
          announced = null;
          void loadRecords().then((records) => {
            if (earlier?.id !== id) return;
            earlier.earned = earnedFrom(records.filter((r) => r.id !== id));
            renderAchieved();
          });
        }
        const fresh = earlier.earned ? newIn(controller.record, earlier.earned) : [];
        const names = fresh.map(({ id: a, level }) => `${ACHIEVEMENTS.find((x) => x.id === a)!.name} <span class="muted">(${LEVELS[level].name})</span>`);
        el.innerHTML = names.length
          ? `New: ${names.join(", ")} · <a href="#/achievements">Achievements</a>`
          : `<a href="#/achievements">Achievements</a>`;
        if (!earlier.earned) return;
        // A pop-up once per achievement level, when it is earned (not for those earned before
        // this screen opened, nor again after a takeback undid and the game re-earned one).
        const keys = fresh.map((f) => `${f.id}:${f.level}`);
        if (!announced) {
          announced = new Set(keys);
          return;
        }
        const pop = fresh.filter((_, i) => !announced!.has(keys[i]));
        for (const k of keys) announced.add(k);
        if (pop.length) showToast(pop);
      };

      // The achievement pop-up: above the move list, never over the board, no sound; fades
      // after a few seconds, opens the Achievements screen when clicked.
      let announced: Set<string> | null = null;
      let toastTimer = 0;
      const showToast = (items: { id: string; level: number }[]) => {
        const el = $<HTMLAnchorElement>(".play-toast");
        const tc = controller.setup.tc;
        const engine = tc.kind === "odds" ? ` · engine ${formatSeconds(tc.engineSeconds)}` : "";
        el.innerHTML = items
          .map(({ id, level }) => {
            const a = ACHIEVEMENTS.find((x) => x.id === id)!;
            return `<span class="toast-line"><b>★ ${a.name}</b> <span class="muted">${a.text} · ${LEVELS[level].name}${engine}</span></span>`;
          })
          .join("");
        el.hidden = false;
        el.classList.remove("show");
        void el.offsetWidth; // restart the animation
        el.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => (el.hidden = true), TOAST_MS);
      };

      const renderMoves = () => {
        const game = controller.game;
        const list = $<HTMLOListElement>(".move-list");
        // After a takeback or a new game, a move at the same ply is new again.
        flashedPly = Math.min(flashedPly, game.moves.length - 1);
        list.replaceChildren();
        const [, side, , , , full] = game.startFen.split(" ");
        const sans = game.moves.map((m) => m.san);
        const offset = side === "b" ? 1 : 0;
        if (offset) sans.unshift("…");
        // Games with odds: the player's moves that were the engine's own choice for them.
        const found = controller.odds ? controller.found : {};
        for (let i = 0; i < sans.length; i += 2) {
          const li = document.createElement("li");
          li.innerHTML = `<span class="move-number muted">${Number(full ?? 1) + i / 2}.</span>`;
          sans.slice(i, i + 2).forEach((san, k) => {
            const ply = i + k - offset;
            const span = document.createElement("span");
            span.className = "move";
            span.textContent = san;
            if (found[ply]) {
              span.classList.add("engine-choice");
              span.title = "The engine's choice for you";
              // Flashes once, when the move is played.
              if (ply > flashedPly) {
                span.classList.add("fresh");
                flashedPly = ply;
              }
            }
            li.append(span);
          });
          list.append(li);
        }
        const lastMove = list.querySelector("li:last-child .move:last-child");
        lastMove?.classList.add("current");
        lastMove?.scrollIntoView({ block: "nearest", inline: "nearest" });
      };

      const renderClocks = () => {
        const c = controller;
        const rows: [string, Side][] = [
          [".play-top .clock", c.engineSide],
          [".play-bottom .clock", c.setup.human],
        ];
        for (const [sel, side] of rows) {
          const el = $<HTMLElement>(sel);
          if (c.clocks && side === c.setup.human && noClock(c.setup.tc)) {
            el.textContent = "no clock";
            el.className = "clock small muted";
            continue;
          }
          if (!c.clocks) {
            el.textContent = side === c.engineSide && c.setup.tc.kind === "move" ? `${c.setup.tc.seconds} s / move` : "";
            el.className = "clock small muted";
            continue;
          }
          const ms = c.clocks.remaining(side);
          el.textContent = formatClock(ms);
          // Extra time for the first move (Chess960) runs before the clock: shown in front of it.
          const extra = c.clocks.extraLeft(side);
          if (extra > 0) {
            const badge = document.createElement("span");
            badge.className = "clock-extra";
            badge.title = "Extra time for your first move";
            badge.textContent = "+" + formatClock(extra);
            el.prepend(badge);
          }
          el.className = "clock numeric";
          el.classList.toggle("running", c.clocks.runningSide() === side);
          el.classList.toggle("overstepped", ms < 0);
        }
      };

      const tip = $<HTMLElement>(".star-tip");
      const hideTip = () => (tip.hidden = true);
      root.querySelector(".play-actions")!.addEventListener("click", async (e) => {
        const action = (e.target as Element).closest<HTMLElement>("[data-action]")?.dataset.action;
        if (action !== "star") hideTip();
        if (action === "undo") controller.undo();
        else if (action === "hint") controller.requestHint();
        else if (action === "evaluation") controller.requestEvaluation();
        else if (action === "colors") openBoardThemePicker();
        else if (action === "bookmark") {
          const start = startOf();
          if (start) {
            bookmarked = await toggleBookmark(start.white, start.black);
            paintBookmark();
            // Saved already; the note is optional, and can also be edited in the new-game sheet.
            hideNote();
            note.hidden = !bookmarked;
          }
        }
        else if (action === "star") {
          tip.hidden = !tip.hidden;
          render();
        } else if (action === "new" || action === "odds") {
          const setup = await chooseNewGame(undefined, undefined, action === "odds");
          if (setup) controller.start(setup);
        }
      });
      const onDocDown = (e: PointerEvent) => {
        if (!(e.target as Element).closest?.('[data-action="star"]')) hideTip();
      };
      document.addEventListener("pointerdown", onDocDown);

      const unsubscribe = controller.subscribe(render);
      const timer = setInterval(() => {
        controller.tick();
        renderClocks();
      }, 100);
      controller.activate();
      openPickerIfRequested();
      render();

      return () => {
        clearTimeout(toastTimer);
        clearInterval(timer);
        unsubscribe();
        document.removeEventListener("pointerdown", onDocDown);
        controller.deactivate();
      };
    },
  };
}
