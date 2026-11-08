// The Progress screen: all 960 Chess960 start positions as tiles, with the games played on
// this device. The upper left half of a tile is the player as White, the lower right as Black.
// Wins count with the gold star, against Dark C. Helmet also with the silver one.
import { chess960Fen } from "../chess/chess960.ts";
import type { PieceCode } from "../chess/fen.ts";
import type { Side } from "../play/clocks.ts";
import type { PlayController } from "../play/controller.ts";
import {
  allWonAgainstEngine,
  level,
  loadRecords,
  OPPONENT_NAMES,
  OPPONENTS,
  progressByPosition,
  type OpponentKey,
  type PositionProgress,
} from "../play/history.ts";
import { chooseNewGame, type Choices } from "../play/new-game.ts";
import { pieceUrl } from "../ui/board.ts";
import type { Screen } from "../ui/shell.ts";
import { fischerEggOnce } from "./fischer-egg.ts";
import "../styles/progress.css";

const COLS = 32;
const CELL = 20;
const STANDARD = 518;

function backRank(n: number): string {
  return chess960Fen(n).split(" ")[0].split("/")[7];
}

export function progressScreen(controller: PlayController): Screen {
  let filter: OpponentKey | null = null;
  let selected: number | null = null;

  return {
    mount(root) {
      root.innerHTML = `
        <section class="page progress">
          <h1 class="title">Chess960 progress</h1>
          <p class="muted">Each tile is one of the 960 start positions, numbered from 0 at the top left to 959
            at the bottom right. The upper left half shows your games as White, the lower right half your
            games as Black. Only wins with the gold star count, or with the silver star against
            Dark C. Helmet. Position 518, standard chess, has a frame.</p>
          <div class="segmented" role="radiogroup" aria-label="Opponent">
            <label><input type="radio" name="opp" value="" checked>All</label>
            ${OPPONENTS.map((o) => `<label><input type="radio" name="opp" value="${o}">${o === "engine" ? "Engine" : o}</label>`).join("")}
          </div>
          <dl class="pg-stats numeric"></dl>
          <svg class="pg-grid" viewBox="0 0 ${COLS * CELL} ${(960 / COLS) * CELL}" role="img"
            aria-label="The 960 start positions with your games"></svg>
          <ul class="pg-legend small muted">
            <li><i class="lv-n"></i>Not played</li>
            <li><i class="lv-0"></i>Played, no win with a star</li>
            <li><i class="lv-1"></i>Beat 1300</li>
            <li><i class="lv-2"></i>Beat 1600</li>
            <li><i class="lv-3"></i>Beat the engine</li>
          </ul>
          <div class="pg-detail" hidden></div>
          <div class="pg-actions"><button class="btn-secondary" data-action="random">Play one I haven't won yet</button></div>
          <p class="pg-none small muted" hidden></p>
        </section>`;
      const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
      const svg = $<SVGSVGElement>(".pg-grid");
      let progress = new Map<number, PositionProgress>();
      let alive = true;

      const play = async (n: number, color: Side) => {
        const preset: Partial<Choices> = { variant: "chess960", start960: "number", number960: n, color };
        if (filter) preset.opponent = filter === "engine" ? "engine" : `human-${filter}`;
        const setup = await chooseNewGame(undefined, preset);
        if (!setup) return;
        controller.start(setup);
        location.hash = "#/play";
      };

      const renderStats = () => {
        let pw = 0, pb = 0, ww = 0, wb = 0, both = 0;
        for (let n = 0; n < 960; n++) {
          const p = progress.get(n);
          const a = level(p, "w", filter), b = level(p, "b", filter);
          if (a >= 0) pw++;
          if (b >= 0) pb++;
          if (a > 0) ww++;
          if (b > 0) wb++;
          if (a > 0 && b > 0) both++;
        }
        $(".pg-stats").innerHTML = `
          <div><dt>As White</dt><dd>${pw} played, ${ww} won</dd></div>
          <div><dt>As Black</dt><dd>${pb} played, ${wb} won</dd></div>
          <div><dt>Won with both colours</dt><dd>${both} of 960</dd></div>`;
      };

      const renderGrid = () => {
        let h = "";
        for (let n = 0; n < 960; n++) {
          const x = (n % COLS) * CELL, y = Math.floor(n / COLS) * CELL;
          const p = progress.get(n);
          const lw = level(p, "w", filter), lb = level(p, "b", filter);
          const cls = (lv: number) => (lv < 0 ? "lv-n" : `lv-${lv}`);
          const frame = n === STANDARD ? " standard" : "";
          const sel = n === selected ? " selected" : "";
          h += `<g data-n="${n}"><path class="${cls(lw)}" d="M${x + 1} ${y + 1}h18L${x + 1} ${y + 19}z"/>` +
            `<path class="${cls(lb)}" d="M${x + 19} ${y + 1}v18h-18z"/>` +
            `<rect class="tile${frame}${sel}" x="${x + 1}" y="${y + 1}" width="18" height="18" rx="2"/></g>`;
        }
        svg.innerHTML = h;
      };

      const tallyText = (p: PositionProgress | undefined, side: Side, o: OpponentKey) => {
        const t = p?.games[side][o];
        if (!t?.played) return `<span class="muted">not played</span>`;
        const games = t.played === 1 ? "1 game" : `${t.played} games`;
        return t.wins ? `${games}, ${t.wins} won` : games;
      };

      const renderDetail = () => {
        const el = $<HTMLElement>(".pg-detail");
        el.hidden = selected === null;
        if (selected === null) return;
        const n = selected;
        const p = progress.get(n);
        const rank = [...backRank(n)]
          .map((c) => `<img src="${pieceUrl(c as PieceCode)}" alt="${c}">`)
          .join("");
        el.innerHTML = `
          <h2 class="section-title">No. ${n}${n === STANDARD ? " (standard chess)" : ""}</h2>
          <div class="pg-rank" aria-label="White's pieces: ${backRank(n)}">${rank}</div>
          <table class="pg-table small numeric">
            <thead><tr><th></th><th>As White</th><th>As Black</th></tr></thead>
            <tbody>${OPPONENTS.map(
              (o) => `<tr><th>${OPPONENT_NAMES[o]}</th><td>${tallyText(p, "w", o)}</td><td>${tallyText(p, "b", o)}</td></tr>`,
            ).join("")}</tbody>
          </table>
          <div class="pg-actions">
            <button class="btn-primary" data-action="white">Play as White</button>
            <button class="btn-secondary" data-action="black">Play as Black</button>
            <a class="small" href="#/analysis?${new URLSearchParams({ fen: chess960Fen(n), chess960: "1" })}">Analyze</a>
          </div>`;
      };

      const render = () => {
        renderStats();
        renderGrid();
        renderDetail();
      };

      svg.addEventListener("click", (e) => {
        const g = (e.target as Element).closest<SVGGElement>("g[data-n]");
        if (!g) return;
        selected = Number(g.dataset.n);
        renderGrid();
        renderDetail();
        $(".pg-detail").scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      root.querySelector(".segmented")!.addEventListener("change", (e) => {
        const v = (e.target as HTMLInputElement).value;
        filter = v || null;
        render();
      });
      root.addEventListener("click", (e) => {
        const action = (e.target as Element).closest<HTMLElement>("[data-action]")?.dataset.action;
        if (selected !== null && (action === "white" || action === "black")) play(selected, action === "white" ? "w" : "b");
        else if (action === "random") {
          const open: [number, Side][] = [];
          for (let n = 0; n < 960; n++)
            for (const s of ["w", "b"] as Side[]) if (level(progress.get(n), s, filter) <= 0) open.push([n, s]);
          const none = $<HTMLElement>(".pg-none");
          none.hidden = open.length > 0;
          none.textContent = "You have won every position with both colours. Well done.";
          if (open.length) {
            const [n, s] = open[Math.floor(Math.random() * open.length)];
            play(n, s);
          }
        }
      });

      // Restores the filter chosen before, then loads the games.
      if (filter) root.querySelector<HTMLInputElement>(`input[name="opp"][value="${filter}"]`)!.checked = true;
      render();
      loadRecords().then((records) => {
        if (!alive) return;
        progress = progressByPosition(records);
        render();
        if (allWonAgainstEngine(progress)) void fischerEggOnce(svg);
      });
      return () => {
        alive = false;
      };
    },
  };
}
