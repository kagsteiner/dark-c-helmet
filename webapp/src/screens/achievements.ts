// The Achievements screen: what the player has earned in games with odds against the engine,
// in three tabs like the new-game screen (standard, Chess960, 960²). Each achievement has
// three takeback levels, each with the longest engine time it was earned at.
import { formatSeconds } from "../play/clocks.ts";
import {
  ACHIEVEMENTS,
  earnedFrom,
  LEVELS,
  nextStep,
  SECTIONS,
  tabOf,
  TABS,
  type Earned,
  type Tab,
} from "../play/achievements.ts";
import { loadRecords } from "../play/history.ts";
import type { Screen } from "../ui/shell.ts";
import "../styles/achievements.css";

export function achievementsScreen(): Screen {
  let tab: Tab | null = null;

  return {
    mount(root) {
      root.innerHTML = `
        <section class="page achievements">
          <h1 class="title">Achievements</h1>
          <p class="muted">Earned in challenges against Dark C. Helmet (Play, “Challenge”). Each one has three
            levels by takebacks: <b>Coffeehouse</b> any number, <b>J'adoube</b> at most one,
            <b>Touch-move</b> none. A level shows the longest engine time you earned it at; the next
            step is the next longer engine time. “Within a pawn” means the engine's evaluation for you
            stays above −1.00.</p>
          <div class="segmented" role="radiogroup" aria-label="Variant">
            ${TABS.map((t) => `<label><input type="radio" name="tab" value="${t.key}">${t.label}</label>`).join("")}
          </div>
          <p class="ac-count small muted numeric"></p>
          <div class="ac-body"><p class="muted">Loading…</p></div>
        </section>`;
      const body = root.querySelector<HTMLElement>(".ac-body")!;
      let earned: Earned | null = null;
      let alive = true;

      const render = () => {
        if (!earned || !tab) return;
        root.querySelector<HTMLInputElement>(`input[value="${tab}"]`)!.checked = true;
        const mine = earned[tab];
        const total = ACHIEVEMENTS.length * LEVELS.length;
        const got = ACHIEVEMENTS.reduce((n, a) => n + (mine[a.id]?.filter((s) => s !== undefined).length ?? 0), 0);
        root.querySelector(".ac-count")!.textContent = `${got} of ${total} levels earned`;
        body.innerHTML = SECTIONS.map((section) => {
          const items = ACHIEVEMENTS.filter((a) => a.section === section)
            .map((a) => {
              const levels = LEVELS.map((lv, i) => {
                const s = mine[a.id]?.[i];
                if (s === undefined) return `<li class="ac-level" title="${lv.text}: not yet">${lv.name}<span>not yet</span></li>`;
                const next = nextStep(s);
                const title = `${lv.text}: earned with the engine at ${formatSeconds(s)}` + (next ? `; next: ${formatSeconds(next)}` : "");
                return `<li class="ac-level earned" title="${title}">${lv.name}<span>${formatSeconds(s)}${next ? ` · next ${formatSeconds(next)}` : ""}</span></li>`;
              }).join("");
              const any = mine[a.id]?.[0] !== undefined;
              return `<li class="ac-item${any ? " earned" : ""}"><div class="ac-name">${a.name}</div>
                <div class="ac-text small muted">${a.text}</div><ul class="ac-levels small numeric">${levels}</ul></li>`;
            })
            .join("");
          return `<h2 class="section-title">${section}</h2><ul class="ac-list">${items}</ul>`;
        }).join("");
      };

      root.querySelector(".segmented")!.addEventListener("change", (e) => {
        tab = (e.target as HTMLInputElement).value as Tab;
        render();
      });

      void loadRecords().then((records) => {
        if (!alive) return;
        earned = earnedFrom(records);
        // First the tab of the latest game with odds.
        if (!tab) {
          const latest = records.filter((r) => r.odds).sort((a, b) => b.started - a.started)[0];
          tab = latest ? tabOf(latest) : "standard";
        }
        render();
      });
      return () => {
        alive = false;
      };
    },
  };
}
