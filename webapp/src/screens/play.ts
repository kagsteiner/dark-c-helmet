// The Play screen: renders the PlayController's game and passes the player's input to it.
import { placementFromFen } from "../chess/fen.ts";
import { describeTimeControl, formatClock, type Side } from "../play/clocks.ts";
import type { PlayController, StarLoss } from "../play/controller.ts";
import { chooseNewGame } from "../play/new-game.ts";
import { Board } from "../ui/board.ts";
import { icons } from "../ui/icons.ts";
import { MoveInput } from "../ui/move-input.ts";
import type { Screen } from "../ui/shell.ts";
import "../styles/play.css";

const STAR_TEXT: Record<StarLoss | "lit", string> = {
  lit: "Clean game so far: no undo, no hints.",
  undo: "Star lost: you took back a move.",
  hint: "Star lost: you asked for a hint.",
  evaluation: "Star lost: you asked for an evaluation.",
  analysis: "Star lost: you opened the analysis.",
  time: "Star lost: your time ran out.",
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
            <span class="spacer"></span>
            <button class="btn-secondary" data-action="new">New game</button>
            <p class="star-tip small" role="status" hidden></p>
          </div>
        </section>`;
      const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
      $(".play-board").append(board.el);

      const input = new MoveInput(board, {
        onMove: (uci) => controller.humanMove(uci),
        targetOnly: () => true,
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
        $(".play-top .player-name").textContent = "Dark C. Helmet";
        $(".play-bottom .player-name").textContent = human === "w" ? "You (White)" : "You (Black)";
        const tc = describeTimeControl(c.setup.tc);
        $(".play-meta").textContent =
          (c.setup.chess960 ? `Chess960 no. ${c.setup.position960 ?? "?"} · ` : "") + tc;
        renderMoves();
        renderClocks();

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
                  ? "Your move."
                  : "");
        $(".play-help").textContent = c.hint ? `Hint: ${c.hint.san}` : c.evaluation ? `Evaluation: ${c.evaluation}` : "";

        const helpAllowed = humanTurn && !!c.engine && !c.helping;
        $<HTMLButtonElement>('[data-action="undo"]').disabled = !c.canUndo;
        $<HTMLButtonElement>('[data-action="hint"]').disabled = !helpAllowed;
        $<HTMLButtonElement>('[data-action="evaluation"]').disabled = !helpAllowed;
        const star = $<HTMLButtonElement>('[data-action="star"]');
        star.innerHTML = c.star ? icons.starOut : icons.starLit;
        star.classList.toggle("lit", !c.star);
        const tip = $<HTMLElement>(".star-tip");
        if (!tip.hidden) tip.textContent = STAR_TEXT[c.star ?? "lit"];
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
