// The Settings screen: engine resources, move input, theme; about the app.
import { defaultEngineOptions } from "../engine/engine.ts";
import { threadsAvailable } from "../engine/transport.ts";
import type { PlayController } from "../play/controller.ts";
import { settings, updateSettings, type Theme } from "../settings.ts";
import type { Screen } from "../ui/shell.ts";
import "../styles/settings.css";

const HASH_SIZES = [16, 32, 64, 128, 256, 512];

export function settingsScreen(controller: PlayController): Screen {
  return {
    mount(root) {
      const s = settings();
      const defaults = defaultEngineOptions();
      const maxThreads = threadsAvailable() ? Math.max(1, Math.min(16, navigator.hardwareConcurrency || 1)) : 1;
      const threads = s.threads ?? defaults.threads;
      const hash = s.hashMb ?? defaults.hashMb;
      const option = (v: number, selected: number, label: string) =>
        `<option value="${v}"${v === selected ? " selected" : ""}>${label}</option>`;

      root.innerHTML = `
        <section class="page settings">
          <h1 class="title">Settings</h1>

          <h2 class="section-title">Engine</h2>
          <div class="field-row">
            <label class="field">
              <span class="field-label">Threads</span>
              <select name="threads"${maxThreads === 1 ? " disabled" : ""}>
                ${Array.from({ length: maxThreads }, (_, i) => option(i + 1, threads, String(i + 1) + (i + 1 === defaults.threads ? " (default)" : ""))).join("")}
              </select>
            </label>
            <label class="field">
              <span class="field-label">Hash table</span>
              <select name="hash">${HASH_SIZES.map((h) => option(h, hash, `${h} MB` + (h === defaults.hashMb ? " (default)" : ""))).join("")}</select>
            </label>
          </div>
          <p class="small muted">${
            threadsAvailable()
              ? "More threads search faster but use more battery. Phones default to 2 threads."
              : "This page cannot use threads (it needs HTTPS or localhost), so the engine runs on one thread."
          }</p>

          <h2 class="section-title">Moves</h2>
          <label class="check"><input type="checkbox" name="targetOnly"${s.targetOnly ? " checked" : ""}>
            Clicking a square moves the only piece that can go there</label>

          <h2 class="section-title">Appearance</h2>
          <div class="segmented" role="radiogroup" aria-label="Theme">
            ${(["system", "light", "dark"] as Theme[])
              .map((t) => `<label><input type="radio" name="theme" value="${t}"${t === s.theme ? " checked" : ""}>${t[0].toUpperCase() + t.slice(1)}</label>`)
              .join("")}
          </div>

          <p class="settings-status small muted" aria-live="polite"></p>

          <h2 class="section-title">About</h2>
          <dl class="about numeric"></dl>
          <p class="small muted">Games, the opening book and settings are stored in this browser on this device only.</p>
          <p class="small muted">Engine and app: MIT license, © 2026 Karlheinz Agsteiner. Chess pieces by Colin M.L. Burnett
            (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC BY-SA 3.0</a>).</p>
        </section>`;
      const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
      const section = $<HTMLElement>(".settings");

      const renderAbout = () => {
        const e = controller.engine;
        const nps = e?.nps ? `${(e.nps / 1e6).toFixed(1)} million nodes/s` : "not measured yet";
        $(".about").innerHTML = e
          ? `<dt>Engine</dt><dd>${e.name}</dd><dt>Net</dt><dd>${e.net}</dd>
             <dt>Threads in use</dt><dd>${e.currentOptions.threads}${e.canStop ? "" : " (single-threaded build)"}</dd>
             <dt>Speed here</dt><dd>${nps}</dd>`
          : `<dt>Engine</dt><dd>loading…</dd>`;
      };

      const applyEngine = async () => {
        const e = controller.engine;
        const s = settings();
        if (!e) return;
        $(".settings-status").textContent = "Applying…";
        await e.setOptions({ threads: s.threads ?? defaults.threads, hashMb: s.hashMb ?? defaults.hashMb });
        $(".settings-status").textContent = "Saved.";
        renderAbout();
      };

      section.addEventListener("change", (ev) => {
        const t = ev.target as HTMLInputElement;
        if (t.name === "threads") {
          const v = Number(t.value);
          updateSettings({ threads: v === defaults.threads ? null : v });
          applyEngine();
        } else if (t.name === "hash") {
          const v = Number(t.value);
          updateSettings({ hashMb: v === defaults.hashMb ? null : v });
          applyEngine();
        } else if (t.name === "targetOnly") {
          updateSettings({ targetOnly: t.checked });
          $(".settings-status").textContent = "Saved.";
        } else if (t.name === "theme") {
          updateSettings({ theme: t.value as Theme });
          $(".settings-status").textContent = "Saved.";
        }
      });

      renderAbout();
      return controller.subscribe(renderAbout);
    },
  };
}
