// The Setup screen: edit a position, then play it against the engine or analyse it.
import { chess960Fen, randomChess960 } from "../chess/chess960.ts";
import type { PieceCode } from "../chess/fen.ts";
import { Game, START_FEN } from "../chess/game.ts";
import {
  castlingRook,
  emptyPosition,
  epCandidates,
  fromFen,
  needsChess960,
  normalizeCastling,
  problems,
  toFen,
  type CastleKey,
  type EditPosition,
} from "../chess/position-edit.ts";
import type { Rules } from "../chess/rules.ts";
import { squareName } from "../chess/san.ts";
import type { PlayController } from "../play/controller.ts";
import { chooseNewGame } from "../play/new-game.ts";
import { Board, pieceUrl, type BoardInput } from "../ui/board.ts";
import type { Screen } from "../ui/shell.ts";
import "../styles/setup.css";

const PALETTE: PieceCode[] = ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"];
const PIECE_NAMES: Record<string, string> = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight", P: "pawn" };
const CASTLING: [CastleKey, string][] = [
  ["K", "White O-O"],
  ["Q", "White O-O-O"],
  ["k", "Black O-O"],
  ["q", "Black O-O-O"],
];

export function setupScreen(rules: Rules, controller: PlayController): Screen {
  // The position being edited survives switching screens.
  let pos: EditPosition = fromFen(START_FEN)!;
  let selected: PieceCode = "Q";
  const board = new Board();

  return {
    mount(root) {
      root.innerHTML = `
        <section class="setup">
          <div class="setup-board"></div>
          <div class="setup-panel">
            <div class="palette" role="radiogroup" aria-label="Piece to place">
              ${PALETTE.map(
                (p) =>
                  `<button class="palette-piece" role="radio" data-piece="${p}" aria-label="${p === p.toUpperCase() ? "White" : "Black"} ${PIECE_NAMES[p.toUpperCase()]}" style="background-image:url(&quot;${pieceUrl(p)}&quot;)"></button>`,
              ).join("")}
            </div>
            <p class="small muted">Tap an empty square to place the selected piece, tap a piece to remove it, drag a piece to move it.</p>
            <div class="setup-presets">
              <button class="btn-secondary" data-preset="start">Start position</button>
              <button class="btn-secondary" data-preset="960">Chess960</button>
              <button class="btn-secondary" data-preset="empty">Empty board</button>
              <button class="btn-secondary" data-preset="game">Current game</button>
            </div>
            <div class="field">
              <span class="field-label">Side to move</span>
              <div class="segmented" role="radiogroup">
                <label><input type="radio" name="turn" value="w">White</label>
                <label><input type="radio" name="turn" value="b">Black</label>
              </div>
            </div>
            <div class="field">
              <span class="field-label">Castling</span>
              <div class="castling">
                ${CASTLING.map(([k, label]) => `<label class="check"><input type="checkbox" data-castle="${k}">${label}</label>`).join("")}
              </div>
            </div>
            <label class="field" data-ep>
              <span class="field-label">En passant</span>
              <select name="ep"></select>
            </label>
            <label class="field">
              <span class="field-label">FEN</span>
              <input type="text" name="fen" spellcheck="false" autocomplete="off" autocapitalize="off">
            </label>
            <div class="setup-problems small error" aria-live="polite"></div>
            <div class="setup-actions">
              <button class="btn-secondary" data-action="analyze">Analyze</button>
              <button class="btn-primary" data-action="play">Play</button>
            </div>
          </div>
        </section>`;
      const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
      $(".setup-board").append(board.el);
      board.setOrientation("white");
      board.setArrows([]);
      board.setHighlights({});

      const fenInput = $<HTMLInputElement>('input[name="fen"]');
      const epSelect = $<HTMLSelectElement>('select[name="ep"]');

      // Through a Game, so that the game in progress is replayed into the rules module afterwards.
      const opponentInCheck = () => {
        const flipped = toFen({ ...pos, turn: pos.turn === "w" ? "b" : "w", ep: null });
        try {
          return new Game(rules, flipped, needsChess960(pos)).inCheck();
        } catch {
          return false;
        }
      };

      const render = (animate = false) => {
        normalizeCastling(pos);
        board.setPlacement(pos.placement, animate);
        for (const b of root.querySelectorAll<HTMLElement>(".palette-piece")) {
          b.setAttribute("aria-checked", String(b.dataset.piece === selected));
        }
        for (const r of root.querySelectorAll<HTMLInputElement>('input[name="turn"]')) r.checked = r.value === pos.turn;
        for (const c of root.querySelectorAll<HTMLInputElement>("[data-castle]")) {
          const key = c.dataset.castle as CastleKey;
          c.disabled = castlingRook(pos.placement, key) === null;
          c.checked = pos.castling[key];
        }
        const eps = epCandidates(pos);
        $<HTMLElement>("[data-ep]").hidden = !eps.length;
        epSelect.innerHTML =
          `<option value="">None</option>` +
          eps.map((sq) => `<option value="${sq}"${sq === pos.ep ? " selected" : ""}>${squareName(sq)}</option>`).join("");
        const fen = toFen(pos);
        if (document.activeElement !== fenInput) fenInput.value = fen;
        const list = problems(pos, opponentInCheck);
        $(".setup-problems").innerHTML = list.map((p) => `<p>${p}</p>`).join("");
        $<HTMLButtonElement>('[data-action="play"]').disabled = list.length > 0;
        $<HTMLButtonElement>('[data-action="analyze"]').disabled = list.length > 0;
      };

      const input: BoardInput = {
        pointerDown: (sq) => pos.placement[sq] !== null, // pieces can be dragged
        release: (sq) => {
          // A tap: remove the piece, or place the selected one on an empty square.
          pos.placement[sq] = pos.placement[sq] ? null : selected;
          render();
        },
        drop: (from, to) => {
          const piece = pos.placement[from];
          pos.placement[from] = null;
          if (to !== null) pos.placement[to] = piece;
          render();
        },
      };
      board.setInput(input);

      // Listeners on the screen's own element: `root` outlives this screen.
      const section = $<HTMLElement>(".setup");
      section.addEventListener("click", (e) => {
        const t = e.target as HTMLElement;
        const piece = t.closest<HTMLElement>("[data-piece]")?.dataset.piece;
        const preset = t.closest<HTMLElement>("[data-preset]")?.dataset.preset;
        const action = t.closest<HTMLElement>("[data-action]")?.dataset.action;
        if (piece) {
          selected = piece as PieceCode;
          render();
        } else if (preset) {
          if (preset === "start") pos = fromFen(START_FEN)!;
          else if (preset === "960") pos = fromFen(chess960Fen(randomChess960()))!;
          else if (preset === "empty") pos = emptyPosition();
          else pos = fromFen(controller.game.fen())!;
          render(true);
        } else if (action) {
          const fen = toFen(pos);
          const chess960 = needsChess960(pos);
          if (action === "play") {
            chooseNewGame({ startFen: fen, chess960 }).then((setup) => {
              if (!setup) return;
              controller.start(setup);
              location.hash = "#/play";
            });
          } else {
            location.hash = `#/analysis?fen=${encodeURIComponent(fen)}${chess960 ? "&chess960=1" : ""}`;
          }
        }
      });

      section.addEventListener("change", (e) => {
        const t = e.target as HTMLInputElement;
        if (t.name === "turn") pos.turn = t.value as "w" | "b";
        else if (t.dataset.castle) pos.castling[t.dataset.castle as CastleKey] = t.checked;
        else if (t.name === "ep") pos.ep = t.value === "" ? null : Number(t.value);
        else if (t.name === "fen") {
          const parsed = fromFen(t.value);
          if (parsed) pos = parsed;
          fenInput.classList.toggle("invalid", !parsed);
          t.blur();
          render(true);
          return;
        }
        render();
      });

      render();
    },
  };
}
