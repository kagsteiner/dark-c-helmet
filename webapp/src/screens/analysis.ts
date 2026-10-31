// The Analysis screen: step through a game or a position, try moves, let the engine analyse
// without end, or review the whole game (evaluation graph, marks for weak moves).
import { markMoves, MARK_SYMBOL, whiteCp, type Mark } from "../analysis/review.ts";
import { record } from "../book/book.ts";
import { placementFromFen } from "../chess/fen.ts";
import { Game, type PlayedMove } from "../chess/game.ts";
import type { Rules } from "../chess/rules.ts";
import type { SearchInfo } from "../engine/engine.ts";
import { formatScore, type PlayController } from "../play/controller.ts";
import { Board, type Color } from "../ui/board.ts";
import { EvalGraph } from "../ui/eval-graph.ts";
import { icons } from "../ui/icons.ts";
import { MoveInput } from "../ui/move-input.ts";
import { settings } from "../settings.ts";
import type { Screen } from "../ui/shell.ts";
import "../styles/play.css";
import "../styles/analysis.css";

interface Line {
  startFen: string;
  chess960: boolean;
  moves: string[];
  /** "game": copied from the game in progress (gameMoves = its moves at that time). */
  source: "game" | "position";
  gameMoves: string;
}

interface Review {
  evals: (number | null)[];
  marks: (Mark | null)[];
}

const REVIEW_TIMES = [0.5, 1, 2, 5, 10]; // seconds per position

function formatCount(n: number): string {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + "G" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
}

export function analysisScreen(rules: Rules, controller: PlayController): Screen {
  // Survive switching screens.
  let line: Line | null = null;
  let cursor = 0;
  let review: Review | null = null;
  let reviewSeconds = 1;
  let orientation: Color = "white";
  const board = new Board();

  return {
    mount(root) {
      // Which line to show: a position from Setup (#/analysis?fen=...), else the current game.
      const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
      const fen = params.get("fen");
      const game = controller.game;
      const gameMoves = game.moves.map((m) => m.uci);
      if (fen) {
        if (!line || line.source !== "position" || line.startFen !== fen) {
          line = { startFen: fen, chess960: params.get("chess960") === "1", moves: [], source: "position", gameMoves: "" };
          cursor = 0;
          review = null;
        }
        history.replaceState(null, "", "#/analysis"); // a later visit shows the game again
      } else {
        if (!line || line.source !== "game" || line.gameMoves !== gameMoves.join(" ")) {
          line = { startFen: game.startFen, chess960: game.chess960, moves: gameMoves, source: "game", gameMoves: gameMoves.join(" ") };
          cursor = gameMoves.length;
          review = null;
          orientation = controller.setup.human === "w" ? "white" : "black";
        }
        controller.analysisOpened(); // costs the star while the game is on
      }
      const fromRunningGame = line.source === "game" && !controller.result;

      root.innerHTML = `
        <section class="analysis">
          <div class="an-board"></div>
          <div class="an-nav">
            <button class="btn-icon" data-nav="first" aria-label="Start" title="Start">${icons.first}</button>
            <button class="btn-icon" data-nav="prev" aria-label="Back" title="Back (←)">${icons.prev}</button>
            <button class="btn-icon" data-nav="flip" aria-label="Flip board" title="Flip board">${icons.flip}</button>
            <button class="btn-icon" data-nav="next" aria-label="Forward" title="Forward (→)">${icons.next}</button>
            <button class="btn-icon" data-nav="last" aria-label="End" title="End">${icons.last}</button>
          </div>
          <div class="an-panel">
            ${fromRunningGame ? `<div class="an-header"><span class="small muted">Analyzing the game in progress</span><a class="btn-secondary back" href="#/play">Back to game</a></div>` : ""}
            <div class="an-engine">
              <div class="an-engine-top">
                <button class="btn-icon" data-action="toggle" aria-label="Start analysis"></button>
                <span class="an-score numeric"></span>
                <span class="an-details small muted numeric"></span>
              </div>
              <p class="an-pv small"></p>
            </div>
            <ol class="move-list an-moves numeric" aria-label="Moves"></ol>
            <div class="an-graph"></div>
            <div class="an-review">
              <div class="an-review-row">
                <label class="field">
                  <span class="field-label">Review the game, time per move</span>
                  <select name="reviewTime">${REVIEW_TIMES.map((t) => `<option value="${t}"${t === reviewSeconds ? " selected" : ""}>${t} s</option>`).join("")}</select>
                </label>
                <button class="btn-secondary" data-action="review">Review</button>
              </div>
              <p class="an-review-status small muted"></p>
            </div>
          </div>
        </section>`;
      const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
      const section = $<HTMLElement>(".analysis");
      $(".an-board").append(board.el);
      const graph = new EvalGraph((ply) => goTo(ply));
      $(".an-graph").append(graph.el);

      let analyzing = false; // endless analysis running
      let lastInfo: SearchInfo | null = null;
      let reviewing: { token: number; done: number; total: number } | null = null;
      let token = 0;

      // Positions of the line: fens[i] after i moves, played[i] the (i+1)-th move.
      let fens: string[] = [];
      let played: PlayedMove[] = [];
      const rebuild = () => {
        const g = new Game(rules, line!.startFen, line!.chess960);
        fens = [g.fen()];
        played = [];
        for (const m of line!.moves) {
          const p = g.play(m);
          if (!p) break;
          played.push(p);
          fens.push(g.fen());
        }
        line!.moves = played.map((p) => p.uci);
        cursor = Math.min(cursor, played.length);
      };
      const gameAt = (ply: number) => {
        const g = new Game(rules, line!.startFen, line!.chess960);
        for (const m of line!.moves.slice(0, ply)) g.play(m);
        return g;
      };
      const whiteToMoveAt = (ply: number) => fens[ply].split(" ")[1] === "w";
      const moveLabel = (i: number) => {
        // "12. e4" or "12… e5" for the move leading to position i + 1
        const [, side, , , , full] = line!.startFen.split(" ");
        const offset = side === "b" ? 1 : 0;
        const number = Number(full ?? 1) + Math.floor((i + offset) / 2);
        return `${number}${(i + offset) % 2 === 0 ? "." : "…"} ${played[i].san}`;
      };

      const input = new MoveInput(board, {
        onMove: (uci) => {
          if (line!.moves[cursor] === uci) {
            cursor++;
          } else {
            line!.moves = [...line!.moves.slice(0, cursor), uci];
            cursor++;
            if (review) review = { evals: review.evals.slice(0, cursor), marks: review.marks.slice(0, cursor - 1) };
            rebuild();
          }
          positionChanged();
        },
        targetOnly: () => settings().targetOnly,
      });
      input.setMode("move");

      const engineSearch = () => {
        const engine = controller.engine;
        if (!engine || !analyzing) return;
        const t = ++token;
        lastInfo = null;
        const searched = gameAt(cursor); // the position of this search, for the book
        engine
          .search(
            { startFen: line!.startFen, moves: line!.moves.slice(0, cursor), chess960: line!.chess960 },
            { infinite: true },
            (info) => {
              if (t !== token) return;
              lastInfo = info;
              renderEngineAndArrow();
            },
          )
          .then((result) => {
            record(searched, result, engine, "analysis");
            if (t === token && analyzing) {
              // The search ended by itself (mate or stalemate on the board).
              analyzing = false;
              renderEngine();
            }
          });
      };

      const stopEngine = () => {
        token++;
        analyzing = false;
        controller.engine?.stop();
      };

      const positionChanged = () => {
        render();
        if (analyzing) engineSearch();
      };

      const goTo = (ply: number) => {
        const p = Math.max(0, Math.min(played.length, ply));
        if (p === cursor) return;
        cursor = p;
        positionChanged();
      };

      const renderEngine = () => {
        const engine = controller.engine;
        const toggle = $<HTMLButtonElement>('[data-action="toggle"]');
        toggle.innerHTML = analyzing ? icons.stop : icons.play;
        toggle.setAttribute("aria-label", analyzing ? "Stop analysis" : "Start analysis");
        toggle.disabled = !engine || reviewing !== null;
        const terminal = gameAt(cursor).state();
        if (!engine) {
          $(".an-score").textContent = "";
          $(".an-details").textContent = "The engine is loading…";
          $(".an-pv").textContent = "";
          return;
        }
        if (!analyzing || !lastInfo) {
          $(".an-score").textContent = "";
          $(".an-details").textContent = analyzing
            ? "Thinking…"
            : terminal !== "ongoing"
              ? "The game is over in this position."
              : "Press play to analyze this position.";
          $(".an-pv").textContent = "";
          return;
        }
        const info = lastInfo;
        $(".an-score").textContent = formatScore(info, whiteToMoveAt(cursor));
        $(".an-details").textContent = `depth ${info.depth}/${info.seldepth} · ${formatCount(info.nodes)} nodes · ${formatCount(info.nps)}/s`;
        // Principal variation in SAN, numbered from the current position.
        const g = gameAt(cursor);
        const [, side, , , , full] = fens[cursor].split(" ");
        let number = Number(full ?? 1);
        let white = side === "w";
        const parts: string[] = [];
        for (const uci of info.pv) {
          const p = g.play(uci);
          if (!p) break;
          if (white) parts.push(`${number}.`);
          else if (!parts.length) parts.push(`${number}…`);
          parts.push(p.san);
          if (!white) number++;
          white = !white;
        }
        $(".an-pv").textContent = parts.join(" ");
      };

      const renderMoves = () => {
        const list = $<HTMLOListElement>(".an-moves");
        list.replaceChildren();
        const [, side, , , , full] = line!.startFen.split(" ");
        const items: (number | null)[] = played.map((_, i) => i);
        if (side === "b") items.unshift(null);
        for (let i = 0; i < items.length; i += 2) {
          const li = document.createElement("li");
          li.innerHTML = `<span class="move-number muted">${Number(full ?? 1) + i / 2}.</span>`;
          for (const idx of items.slice(i, i + 2)) {
            const span = document.createElement("button");
            span.className = "move";
            if (idx === null) {
              span.textContent = "…";
              span.disabled = true;
            } else {
              span.dataset.ply = String(idx + 1);
              span.textContent = played[idx].san;
              const mark = review?.marks[idx];
              if (mark) span.insertAdjacentHTML("beforeend", `<span class="mark-sym ${mark}">${MARK_SYMBOL[mark]}</span>`);
              if (idx + 1 === cursor) span.classList.add("current");
            }
            li.append(span);
          }
          list.append(li);
        }
        list.querySelector(".current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
      };

      const renderReview = () => {
        const status = $(".an-review-status");
        const btn = $<HTMLButtonElement>('[data-action="review"]');
        btn.textContent = reviewing ? "Cancel" : "Review";
        btn.disabled = !controller.engine || played.length === 0;
        if (reviewing) {
          status.textContent = `Reviewing position ${reviewing.done + 1} of ${reviewing.total}…`;
        } else if (review && review.evals.length === played.length + 1 && review.evals.every((e) => e !== null)) {
          const count = (white: boolean, m: Mark) =>
            review!.marks.filter((x, i) => x === m && whiteToMoveAt(i) === white).length;
          const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
          const summary = (white: boolean) =>
            `${white ? "White" : "Black"}: ${n(count(white, "inaccuracy"), "inaccuracy", "inaccuracies")}, ` +
            `${n(count(white, "mistake"), "mistake", "mistakes")}, ${n(count(white, "blunder"), "blunder", "blunders")}`;
          status.textContent = `${summary(true)}. ${summary(false)}.`;
        } else {
          status.textContent = "";
        }
        $<HTMLElement>(".an-graph").hidden = !review;
        if (review) {
          const evals = Array.from({ length: played.length + 1 }, (_, i) => review!.evals[i] ?? null);
          graph.set({ evals, marks: review.marks, labels: played.map((_, i) => moveLabel(i)), cursor });
        }
      };

      const render = () => {
        const fen = fens[cursor];
        const placement = placementFromFen(fen);
        board.setOrientation(orientation);
        board.setPlacement(placement);
        const white = whiteToMoveAt(cursor);
        const g = gameAt(cursor);
        const last = played[cursor - 1];
        input.setPosition(placement, g.state() === "ongoing" ? g.legalMoves() : [], white, {
          lastMove: last ? [last.from, last.castle ? last.rook : last.to] : undefined,
          check: g.inCheck() ? placement.indexOf(white ? "K" : "k") : undefined,
        });
        board.setArrows(analyzing && lastInfo?.pv[0] ? arrowFor(g, lastInfo.pv[0]) : []);
        $<HTMLButtonElement>('[data-nav="first"]').disabled = cursor === 0;
        $<HTMLButtonElement>('[data-nav="prev"]').disabled = cursor === 0;
        $<HTMLButtonElement>('[data-nav="next"]').disabled = cursor === played.length;
        $<HTMLButtonElement>('[data-nav="last"]').disabled = cursor === played.length;
        renderMoves();
        renderEngine();
        renderReview();
      };

      const arrowFor = (g: Game, uci: string) => {
        const m = g.legalMoves().find((x) => x.uci === uci);
        return m ? [{ from: m.from, to: m.castle ? m.rook : m.to }] : [];
      };

      const runReview = async () => {
        const engine = controller.engine;
        if (!engine) return;
        stopEngine();
        const t = ++token;
        const total = played.length + 1;
        const evals: (number | null)[] = new Array(total).fill(null);
        review = { evals, marks: [] };
        reviewing = { token: t, done: 0, total };
        render();
        for (let i = 0; i < total; i++) {
          if (t !== token) return;
          reviewing.done = i;
          renderReview();
          const g = gameAt(i);
          const state = g.state();
          const whiteToMove = whiteToMoveAt(i);
          if (state === "checkmate") evals[i] = whiteToMove ? -10000 : 10000;
          else if (state !== "ongoing") evals[i] = 0;
          else {
            const r = await engine.search(
              { startFen: line!.startFen, moves: line!.moves.slice(0, i), chess960: line!.chess960 },
              { movetime: reviewSeconds * 1000 },
            );
            if (t !== token) return;
            record(g, r, engine, "analysis");
            evals[i] = r.info ? whiteCp(r.info.score, whiteToMove) : null;
          }
          review.marks = markMoves(evals.slice(0, i + 1).map((e) => e ?? 0), whiteToMoveAt(0));
          renderReview();
        }
        reviewing = null;
        render();
      };

      // An arrow for the engine's best move needs the latest info: re-render the board arrow too.
      const baseRenderEngine = renderEngine;
      const renderEngineAndArrow = () => {
        baseRenderEngine();
        if (analyzing && lastInfo?.pv[0]) board.setArrows(arrowFor(gameAt(cursor), lastInfo.pv[0]));
      };

      section.addEventListener("click", (e) => {
        const t = e.target as HTMLElement;
        const nav = t.closest<HTMLElement>("[data-nav]")?.dataset.nav;
        const ply = t.closest<HTMLElement>("[data-ply]")?.dataset.ply;
        const action = t.closest<HTMLElement>("[data-action]")?.dataset.action;
        if (nav === "first") goTo(0);
        else if (nav === "prev") goTo(cursor - 1);
        else if (nav === "next") goTo(cursor + 1);
        else if (nav === "last") goTo(played.length);
        else if (nav === "flip") {
          orientation = orientation === "white" ? "black" : "white";
          render();
        } else if (ply) goTo(Number(ply));
        else if (action === "toggle") {
          if (analyzing) stopEngine();
          else {
            analyzing = true;
            engineSearch();
          }
          render();
        } else if (action === "review") {
          if (reviewing) {
            token++;
            reviewing = null;
            controller.engine?.stop();
            render();
          } else runReview();
        }
      });
      section.addEventListener("change", (e) => {
        const t = e.target as HTMLSelectElement;
        if (t.name === "reviewTime") reviewSeconds = Number(t.value);
      });
      const onKey = (e: KeyboardEvent) => {
        if (e.target instanceof Element && e.target.closest("input, select, textarea")) return;
        if (e.key === "ArrowLeft") goTo(cursor - 1);
        else if (e.key === "ArrowRight") goTo(cursor + 1);
        else if (e.key === "Home") goTo(0);
        else if (e.key === "End") goTo(played.length);
        else return;
        e.preventDefault();
      };
      document.addEventListener("keydown", onKey);
      const unsubscribe = controller.subscribe(() => render()); // e.g. the engine has loaded

      rebuild();
      render();

      return () => {
        token++;
        analyzing = false;
        reviewing = null;
        controller.engine?.stop();
        document.removeEventListener("keydown", onKey);
        unsubscribe();
      };
    },
  };
}
