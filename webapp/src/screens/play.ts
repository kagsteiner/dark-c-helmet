// The Play screen: renders the PlayController's game and passes the player's input to it.
import { placementFromFen } from "../chess/fen.ts";
import { describeTimeControl, formatClock, type Side } from "../play/clocks.ts";
import { opponentName, type PlayController, type StarLoss } from "../play/controller.ts";
import { isBookmarked, setBookmarkNote, startName, toggleBookmark } from "../play/bookmarks.ts";
import { chooseNewGame } from "../play/new-game.ts";
import { Board } from "../ui/board.ts";
import { icons } from "../ui/icons.ts";
import { MoveInput } from "../ui/move-input.ts";
import { settings } from "../settings.ts";
import type { Screen } from "../ui/shell.ts";
import "../styles/play.css";

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
            <ol class="move-list numeric" aria-label="Moves"></ol>
            <p class="play-status small muted" aria-live="polite"></p>
            <p class="play-help small" aria-live="polite"></p>
          </div>
          <div class="play-actions">
            <button class="btn-icon" data-action="undo" aria-label="Take back" title="Take back">${icons.undo}</button>
            <button class="btn-icon" data-action="hint" aria-label="Hint" title="Hint">${icons.hint}</button>
            <button class="btn-icon" data-action="evaluation" aria-label="Evaluation" title="Evaluation">${icons.evaluation}</button>
            <button class="btn-icon star" data-action="star" aria-label="Star" title="Star"></button>
            <button class="btn-icon" data-action="bookmark" aria-label="Bookmark this start position" title="Bookmark this start position" aria-pressed="false" hidden></button>
            <span class="spacer"></span>
            <button class="btn-secondary" data-action="new">New game</button>
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
          tc +
          (c.setup.strongestOpenings ? " · strongest openings" : "");
        renderMoves();
        renderClocks();
        renderBookmark();

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
        $<HTMLButtonElement>('[data-action="undo"]').disabled = !c.canUndo;
        $<HTMLButtonElement>('[data-action="hint"]').disabled = !helpAllowed;
        $<HTMLButtonElement>('[data-action="evaluation"]').disabled = !helpAllowed;
        const star = $<HTMLButtonElement>('[data-action="star"]');
        const silver = c.star === "time";
        star.innerHTML = c.star && !silver ? icons.starOut : icons.starLit;
        star.classList.toggle("lit", !c.star || silver);
        star.classList.toggle("silver", silver);
        const tip = $<HTMLElement>(".star-tip");
        if (!tip.hidden) tip.textContent = STAR_TEXT[c.star ?? "lit"];
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

      const renderMoves = () => {
        const game = controller.game;
        const list = $<HTMLOListElement>(".move-list");
        list.replaceChildren();
        const [, side, , , , full] = game.startFen.split(" ");
        const sans = game.moves.map((m) => m.san);
        if (side === "b") sans.unshift("…");
        for (let i = 0; i < sans.length; i += 2) {
          const li = document.createElement("li");
          li.innerHTML = `<span class="move-number muted">${Number(full ?? 1) + i / 2}.</span>`;
          for (const san of sans.slice(i, i + 2)) {
            const span = document.createElement("span");
            span.className = "move";
            span.textContent = san;
            li.append(span);
          }
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
        } else if (action === "new") {
          const setup = await chooseNewGame();
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
      render();

      return () => {
        clearInterval(timer);
        unsubscribe();
        document.removeEventListener("pointerdown", onDocDown);
        controller.deactivate();
      };
    },
  };
}
