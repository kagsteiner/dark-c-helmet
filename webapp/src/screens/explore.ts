// The Explore page: searches new opening positions in the background, in a tab of its own, and
// lists what it analyzed.
import { contribState, onContribChange, outboxCount, refreshContribStatus } from "../book/contrib-client.ts";
import { EXPLORE_TIMES, formatLine, formatNext, formatScore, type ExploreMix, type ExploreRecord } from "../book/explore.ts";
import { clearExploreLog, Explorer, loadExploreLog } from "../book/explorer.ts";
import type { Rules } from "../chess/rules.ts";
import type { PlayController } from "../play/controller.ts";
import type { Screen } from "../ui/shell.ts";
import "../styles/explore.css";

const SHOWN = 300; // rows until "Show all"

function formatNodes(n: number): string {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + "G" : Math.round(n / 1e6) + "M";
}

function formatSeconds(s: number): string {
  return s < 60 ? `${s} s` : `${s / 60} min`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function row(r: ExploreRecord): string {
  const plies = r.line.length;
  const params = new URLSearchParams({ fen: r.fen });
  if (r.number !== null) params.set("chess960", "1");
  return `<li>
      <div class="ex-line">${r.number === null ? "" : `<span class="muted">Chess960 #${r.number}</span> `}${formatLine(r.line)}
        <strong>${formatNext(plies, r.move)}</strong></div>
      <div class="small muted numeric">${formatScore(r.score, plies)} · depth ${r.depth} · ${formatNodes(r.nodes)} nodes ·
        ${Math.round(r.ms / 1000)} s · ${formatTime(r.date)} ·
        <a href="#/analysis?${params}" target="_blank" rel="noopener">Analyze</a></div>
    </li>`;
}

export function exploreScreen(rules: Rules, controller: PlayController): Screen {
  const explorer = new Explorer(rules, () => controller.engine);
  return {
    mount(root) {
      root.innerHTML = `
        <section class="page explore">
          <h1 class="title">Explore openings</h1>
          <p class="muted">Keep this page open in a tab of its own, and use your computer and this app in other
            tabs as usual. It plays sensible moves from a start position up to the first position the
            opening book does not know yet, searches it and adds the result to the book. It carries on
            when the page is reloaded, and pauses while a laptop runs on battery.</p>
          <div class="field-row">
            <label class="field">
              <span class="field-label">Time per position</span>
              <select name="seconds">${EXPLORE_TIMES.map((t) => `<option value="${t}">${formatSeconds(t)}</option>`).join("")}</select>
            </label>
            <label class="field">
              <span class="field-label">Openings</span>
              <select name="mix">
                <option value="mixed">70% Chess960, 30% standard</option>
                <option value="chess960">Only Chess960</option>
                <option value="standard">Only standard</option>
              </select>
            </label>
          </div>
          <div class="ex-actions"><button class="btn-primary" data-action="toggle">Start</button></div>
          <p class="ex-status" aria-live="polite"></p>
          <p class="ex-current small muted numeric"></p>
          <dl class="ex-stats numeric"></dl>
          <p class="ex-contrib small"></p>
          <p class="small muted">If the page turns out to stop when its tab is hidden for long: add this site under
            "Always keep these sites active" in Chrome's settings (Performance).</p>
          <div class="ex-list-head">
            <h2 class="section-title">Analyzed positions</h2>
            <button class="btn-secondary" data-action="clear" hidden>Clear list</button>
          </div>
          <p class="ex-empty small muted">Nothing analyzed yet.</p>
          <ol class="ex-list"></ol>
          <button class="btn-secondary" data-action="all" hidden></button>
        </section>`;
      const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
      const seconds = $<HTMLSelectElement>('[name="seconds"]');
      const mix = $<HTMLSelectElement>('[name="mix"]');
      const toggle = $<HTMLButtonElement>('[data-action="toggle"]');
      const originalTitle = document.title;
      let log: ExploreRecord[] = [];
      let showAll = false;

      const renderStatus = () => {
        const { status, config } = explorer;
        const texts: Record<typeof status, string> = {
          stopped: "Not exploring.",
          "no-engine": "Waiting for the engine to load…",
          measuring: "Measuring the speed of this device…",
          walking: "Looking for a position the book does not know…",
          searching: `Searching (${formatNodes(config.nodes)} nodes per position).`,
          battery: "Paused: this computer is running on battery.",
          "other-tab": "Already exploring in another tab. Stop it there; this page takes over when that tab is closed.",
        };
        $(".ex-status").textContent = texts[status];
        $(".ex-current").textContent = status === "searching" ? `${explorer.current}${explorer.depth ? ` · depth ${explorer.depth}` : ""}` : "";
        toggle.textContent = config.on ? "Stop" : "Start";
        toggle.disabled = status === "other-tab";
        seconds.disabled = mix.disabled = config.on;
        seconds.value = String(config.seconds);
        mix.value = config.mix;
        document.title = status === "battery" ? "Paused: Explore" : config.on && status !== "other-tab" ? `Exploring: ${log.length}` : originalTitle;
      };

      const renderStats = async () => {
        const speed = (s: { nodes: number; ms: number }) => (s.ms ? `${((s.nodes / s.ms) * 1000 / 1e6).toFixed(1)} M nodes/s` : "–");
        const c = await contribState();
        const waiting = await outboxCount();
        $(".ex-stats").innerHTML = `
          <dt>This session</dt><dd>${explorer.searched} positions</dd>
          <dt>All together</dt><dd>${log.length} positions</dd>
          <dt>Speed, tab visible</dt><dd>${speed(explorer.speed.visible)}</dd>
          <dt>Speed, tab hidden</dt><dd>${speed(explorer.speed.hidden)}</dd>
          <dt>Waiting to be sent</dt><dd>${waiting} moves</dd>`;
        $(".ex-contrib").textContent = !c.enabled
          ? "This browser does not contribute: results stay in the book on this device. You can turn contributions on in Settings."
          : c.state === "approved"
            ? `Results go to the master book as ${c.user}, in the background (${c.improvements ?? 0} moves added so far).`
            : "This browser is not approved yet: results wait here until it is (Settings).";
      };

      const renderList = () => {
        const rows = showAll ? log : log.slice(-SHOWN);
        $(".ex-list").innerHTML = rows.slice().reverse().map(row).join("");
        $(".ex-empty").toggleAttribute("hidden", log.length > 0);
        $('[data-action="clear"]').toggleAttribute("hidden", log.length === 0);
        const all = $<HTMLButtonElement>('[data-action="all"]');
        all.hidden = showAll || log.length <= SHOWN;
        all.textContent = `Show all ${log.length}`;
      };

      const reloadLog = async () => {
        log = await loadExploreLog();
        renderList();
        renderStats();
      };

      explorer.onChange = () => {
        renderStatus();
        if (explorer.status === "other-tab") reloadLog();
      };
      explorer.onRecord = (r) => {
        log.push(r);
        // New rows go on top; rebuilding the list every time would be wasted while hidden.
        if (!showAll && log.length > SHOWN) $(".ex-list").lastElementChild?.remove();
        $(".ex-list").insertAdjacentHTML("afterbegin", row(r));
        $(".ex-empty").toggleAttribute("hidden", true);
        $('[data-action="clear"]').toggleAttribute("hidden", false);
        renderStats();
      };

      root.addEventListener("click", async (e) => {
        const action = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
        if (action === "toggle") {
          if (explorer.config.on) await explorer.stop();
          else await explorer.start(Number(seconds.value), mix.value as ExploreMix);
        } else if (action === "all") {
          showAll = true;
          renderList();
        } else if (action === "clear" && confirm("Clear the list? The opening book stays as it is.")) {
          await clearExploreLog();
          await reloadLog();
        }
      });

      const unsubscribeEngine = controller.subscribe(() => explorer.engineReady());
      const unsubscribeContrib = onContribChange(() => renderStats());
      refreshContribStatus().catch(() => {}).then(renderStats);
      renderStatus();
      reloadLog();
      explorer.attach().then(renderStatus);

      return () => {
        explorer.detach();
        explorer.onChange = () => {};
        explorer.onRecord = () => {};
        unsubscribeEngine();
        unsubscribeContrib();
        document.title = originalTitle;
      };
    },
  };
}
