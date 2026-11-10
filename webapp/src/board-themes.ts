// Board colours: a theme is two square colours (colours only, the pieces never change). The
// dark-mode variant, the coordinates and the highlights follow from them. "Your own" builds a
// board from any one colour. Applied as the CSS variables of styles/tokens.css, in a <style>
// element after it, for light and dark mode.

export interface BoardTheme {
  id: string;
  name: string;
  /** Light and dark squares in light mode. */
  light: string;
  dark: string;
  /** Dark mode, when the derived variant isn't right. */
  night?: { light: string; dark: string };
  /** Last-move highlight, where the usual yellow is too faint. */
  lastMove?: string;
}

export const CUSTOM_ID = "custom";
export const DEFAULT_THEME = "wood";

export const BOARD_THEMES: BoardTheme[] = [
  { id: "wood", name: "Classic wood", light: "#eedcb9", dark: "#b88b62", night: { light: "#d9c3a0", dark: "#9c7553" } },
  { id: "meadow", name: "Meadow", light: "#ebeed3", dark: "#7a9a5c" },
  { id: "ice", name: "Ice", light: "#e3e9ef", dark: "#8aa3b8" },
  { id: "stone", name: "Stone", light: "#e4e3dd", dark: "#a09e96" },
  { id: "walnut", name: "Walnut", light: "#d9b98f", dark: "#8a6440" },
  { id: "lavender", name: "Lavender", light: "#e9e3f1", dark: "#9d8bbd" },
  { id: "coral", name: "Coral", light: "#f6e3d8", dark: "#d38b70" },
  { id: "paper", name: "Paper", light: "#f5f2ea", dark: "#cbc2ae" },
  { id: "contrast", name: "High contrast", light: "#f4f4f4", dark: "#4e6b88", lastMove: "rgba(255, 196, 0, 0.6)" },
];

// --- colour arithmetic ----------------------------------------------------------------------

type Hsl = [h: number, s: number, l: number];

function toHsl(hex: string): Hsl {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function toHex([h, s, l]: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A board from one colour: a light and a dark square of its hue, with enough contrast for the
 *  pieces and the coordinates, whatever colour was picked. */
export function themeFromColor(color: string): BoardTheme {
  const [h, s] = toHsl(color);
  return {
    id: CUSTOM_ID,
    name: "Your own",
    light: toHex([h, clamp(s * 0.55, 0, 0.5), 0.88]),
    dark: toHex([h, clamp(s * 0.65, 0, 0.55), 0.55]),
  };
}

/** Dark mode: both squares a little darker and calmer, so the board doesn't glare at night. */
function nightOf(t: BoardTheme): { light: string; dark: string } {
  if (t.night) return t.night;
  const dim = (hex: string, dl: number) => {
    const [h, s, l] = toHsl(hex);
    return toHex([h, s * 0.85, clamp(l - dl, 0, 1)]);
  };
  return { light: dim(t.light, 0.07), dark: dim(t.dark, 0.07) };
}

// --- applying -------------------------------------------------------------------------------

export function findTheme(id: string, customColor: string): BoardTheme {
  if (id === CUSTOM_ID) return themeFromColor(customColor);
  return BOARD_THEMES.find((t) => t.id === id) ?? BOARD_THEMES[0];
}

function vars(light: string, dark: string, lastMove?: string): string {
  return `--square-light: ${light}; --square-dark: ${dark}; --coord-on-light: ${dark}; --coord-on-dark: ${light};` +
    (lastMove ? ` --last-move: ${lastMove};` : "");
}

/** The CSS for a theme, with the same selectors as tokens.css so that it wins by coming later. */
export function themeCss(t: BoardTheme): string {
  const n = nightOf(t);
  const night = vars(n.light, n.dark, t.lastMove);
  return `:root { ${vars(t.light, t.dark, t.lastMove)} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${night} } }
:root[data-theme="dark"] { ${night} }`;
}

/** Shows the board in theme `t` everywhere in the app (a preview until settings store it). */
export function applyBoardTheme(t: BoardTheme): void {
  let style = document.getElementById("board-theme") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "board-theme";
  }
  document.head.append(style); // always last, after the app's own styles
  style.textContent = themeCss(t);
}
