// User settings, stored on this device.
import { load, save } from "./storage.ts";

export type Theme = "system" | "light" | "dark";

export interface Settings {
  /** Engine threads and hash size; null: the default for this device. */
  threads: number | null;
  hashMb: number | null;
  /** Clicking only the target square moves the one piece that can go there. */
  targetOnly: boolean;
  theme: Theme;
  /** Merge a newer master opening book without asking. */
  autoMergeMaster: boolean;
}

const KEY = "settings";
let current: Settings = { threads: null, hashMb: null, targetOnly: true, theme: "system", autoMergeMaster: false };

export async function loadSettings(): Promise<Settings> {
  current = { ...current, ...(await load<Partial<Settings>>(KEY)) };
  applyTheme();
  return current;
}

export function settings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  save(KEY, current);
  applyTheme();
}

function applyTheme(): void {
  const root = document.documentElement;
  if (current.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = current.theme;
}
