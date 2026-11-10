// The board colour picker: a panel docked at the bottom, with no scrim, so the real board stays
// in view and recolours as you swipe, tap a swatch or press the arrow keys. "Use this" keeps the
// colours; Cancel, Escape or leaving the screen goes back to the saved ones.
import { applyBoardTheme, BOARD_THEMES, CUSTOM_ID, findTheme, themeFromColor, type BoardTheme } from "../board-themes.ts";
import { settings, updateSettings } from "../settings.ts";
import { notifyLocalChange } from "../sync/changes.ts";
import "../styles/board-theme-picker.css";

let openPicker: (() => void) | null = null;
let openOnNextPlay = false;

/** From Settings: open the picker once the Play screen (with its board) is shown. */
export function pickBoardColorsOnPlay(): void {
  openOnNextPlay = true;
  location.hash = "#/play";
}

/** Called by the Play screen when it mounts. */
export function openPickerIfRequested(): void {
  if (!openOnNextPlay) return;
  openOnNextPlay = false;
  openBoardThemePicker();
}

export function openBoardThemePicker(): void {
  if (openPicker) return;
  const saved = settings();
  const ids = [...BOARD_THEMES.map((t) => t.id), CUSTOM_ID];
  let index = Math.max(0, ids.indexOf(saved.boardTheme));
  let color = saved.boardColor;
  const theme = (i: number): BoardTheme => (ids[i] === CUSTOM_ID ? themeFromColor(color) : BOARD_THEMES[i]);

  const panel = document.createElement("div");
  panel.className = "theme-picker";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Board colours");
  panel.innerHTML = `
    <div class="tp-head">
      <div class="tp-name" aria-live="polite"></div>
      <label class="tp-custom" hidden>
        <span class="small muted">Your colour</span>
        <input type="color" value="${color}">
      </label>
      <button class="btn-secondary" type="button" data-tp="cancel">Cancel</button>
      <button class="btn-primary" type="button" data-tp="use">Use this</button>
    </div>
    <div class="tp-swatches" role="radiogroup" aria-label="Board colours">
      ${ids.map((id, i) => `<button type="button" class="tp-swatch${id === CUSTOM_ID ? " custom" : ""}" role="radio" data-index="${i}" aria-label="${theme(i).name}"></button>`).join("")}
    </div>`;
  document.body.append(panel);

  const swatches = [...panel.querySelectorAll<HTMLButtonElement>(".tp-swatch")];
  const custom = panel.querySelector<HTMLLabelElement>(".tp-custom")!;
  const input = custom.querySelector("input")!;

  const paintSwatch = (el: HTMLElement, t: BoardTheme) => {
    el.style.background = `conic-gradient(${t.dark} 0 25%, ${t.light} 0 50%, ${t.dark} 0 75%, ${t.light} 0)`;
  };

  const show = () => {
    const t = theme(index);
    applyBoardTheme(t);
    panel.querySelector(".tp-name")!.textContent = t.name;
    swatches.forEach((s, i) => {
      s.setAttribute("aria-checked", String(i === index));
      paintSwatch(s, theme(i));
    });
    custom.hidden = ids[index] !== CUSTOM_ID;
  };

  const step = (d: number) => {
    index = (index + d + ids.length) % ids.length;
    show();
  };

  const close = (keep: boolean) => {
    if (keep) {
      updateSettings({ boardTheme: ids[index], boardColor: color, boardChanged: Date.now() });
      notifyLocalChange(); // with sync on, the other devices get the colours too
    } else applyBoardTheme(findTheme(saved.boardTheme, saved.boardColor));
    panel.remove();
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("hashchange", onLeave);
    openPicker = null;
  };

  panel.addEventListener("click", (e) => {
    const el = e.target as Element;
    const action = el.closest<HTMLElement>("[data-tp]")?.dataset.tp;
    const swatch = el.closest<HTMLElement>(".tp-swatch");
    if (swatch) {
      index = Number(swatch.dataset.index);
      show();
    } else if (action === "cancel") close(false);
    else if (action === "use") close(true);
  });

  input.addEventListener("input", () => {
    color = input.value;
    show();
  });

  // Swipe left or right anywhere on the panel (not on the colour field).
  let startX: number | null = null;
  panel.addEventListener("pointerdown", (e) => {
    startX = (e.target as Element).closest("input") ? null : e.clientX;
  });
  panel.addEventListener("pointerup", (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
  });

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as Element).closest?.("input")) return;
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "Escape") close(false);
    else return;
    e.preventDefault();
  };
  const onLeave = () => close(false);
  document.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", onLeave);

  openPicker = () => close(false);
  show();
  panel.querySelector<HTMLButtonElement>('[data-tp="use"]')!.focus();
}
