// The Play screen. M1: both sides are moved by hand (the engine joins in M2).
import { chess960Fen, randomChess960 } from "../chess/chess960.ts";
import { placementFromFen } from "../chess/fen.ts";
import { Game, START_FEN } from "../chess/game.ts";
import type { GameState, Rules } from "../chess/rules.ts";
import { Board } from "../ui/board.ts";
import { icons } from "../ui/icons.ts";
import { MoveInput } from "../ui/move-input.ts";
import type { Screen } from "../ui/shell.ts";
import "../styles/play.css";

const RESULT_TEXT: Record<Exclude<GameState, "ongoing">, string> = {
  checkmate: "Checkmate",
  stalemate: "Draw by stalemate",
  threefold: "Draw by threefold repetition",
  fifty: "Draw by the fifty-move rule",
  material: "Draw by insufficient material",
};

export function playScreen(rules: Rules): Screen {
  // The game survives switching screens.
  let game = new Game(rules);
  const board = new Board();

  return {
    mount(root) {
      root.innerHTML = `
        <section class="play">
          <div class="play-player play-top"><span class="player-name"></span></div>
          <div class="play-board"></div>
          <div class="play-player play-bottom"><span class="player-name"></span></div>
          <div class="play-moves">
            <ol class="move-list numeric" aria-label="Moves"></ol>
            <p class="play-status small muted" aria-live="polite"></p>
          </div>
          <div class="play-actions">
            <button class="btn-icon" data-action="undo" aria-label="Undo" title="Undo">${icons.undo}</button>
            <button class="btn-icon" data-action="flip" aria-label="Flip board" title="Flip board">${icons.flip}</button>
            <span class="spacer"></span>
            <button class="btn-secondary" data-action="standard">New game</button>
            <button class="btn-secondary" data-action="chess960">New Chess960</button>
          </div>
        </section>`;
      const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
      // #/play?fen=...&chess960=1 starts from a given position.
      const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
      const fen = params.get("fen");
      if (fen) {
        try {
          game = new Game(rules, fen, params.get("chess960") === "1");
        } catch {
          // invalid FEN: keep the current game
        }
      }
      $(".play-board").append(board.el);

      const input = new MoveInput(board, {
        onMove: (uci) => {
          if (game.play(uci)) update(true);
        },
        targetOnly: () => true,
      });

      const update = (animate: boolean) => {
        const fen = game.fen();
        const placement = placementFromFen(fen);
        board.setPlacement(placement, animate);
        const last = game.moves.at(-1);
        const white = game.turn() === "w";
        const check = game.inCheck() ? placement.indexOf(white ? "K" : "k") : undefined;
        const state = game.state();
        input.setPosition(placement, state === "ongoing" ? game.legalMoves() : [], white, {
          lastMove: last ? [last.from, last.castle ? last.rook : last.to] : undefined,
          check,
        });
        input.setEnabled(state === "ongoing");
        renderPlayers();
        renderMoves();
        $(".play-status").textContent =
          state === "ongoing"
            ? `${white ? "White" : "Black"} to move`
            : RESULT_TEXT[state] + (state === "checkmate" ? `. ${white ? "Black" : "White"} wins.` : ".");
        $<HTMLButtonElement>('[data-action="undo"]').disabled = !game.moves.length;
      };

      const renderPlayers = () => {
        const bottomWhite = board.getOrientation() === "white";
        $(".play-top .player-name").textContent = bottomWhite ? "Black" : "White";
        $(".play-bottom .player-name").textContent = bottomWhite ? "White" : "Black";
      };

      const renderMoves = () => {
        const list = $<HTMLOListElement>(".move-list");
        list.replaceChildren();
        // A game from a position with black to move starts with "1… e5".
        const blackFirst = game.startFen.split(" ")[1] === "b";
        const firstNumber = Number(game.startFen.split(" ")[5] ?? 1);
        const sans = game.moves.map((m) => m.san);
        if (blackFirst) sans.unshift("…");
        for (let i = 0; i < sans.length; i += 2) {
          const li = document.createElement("li");
          li.innerHTML = `<span class="move-number muted">${firstNumber + i / 2}.</span>`;
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

      root.querySelector(".play-actions")!.addEventListener("click", (e) => {
        const action = (e.target as Element).closest<HTMLElement>("[data-action]")?.dataset.action;
        if (action === "undo") {
          if (game.undo()) update(true);
        } else if (action === "flip") {
          board.setOrientation(board.getOrientation() === "white" ? "black" : "white");
          renderPlayers();
        } else if (action === "standard" || action === "chess960") {
          game = action === "standard" ? new Game(rules, START_FEN) : new Game(rules, chess960Fen(randomChess960()), true);
          update(false);
        }
      });

      update(false);
    },
  };
}
