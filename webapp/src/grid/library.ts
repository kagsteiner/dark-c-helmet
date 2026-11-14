// The analyses kept on this device: each one is saved under its own key as the player works,
// and the one last open comes back on the next visit.
import { load, loadAll, removeAll, save } from "../storage.ts";
import type { MoveMark, Origin, PosMark, Score } from "./tree.ts";

const PREFIX = "grid-analysis:";
const CURRENT = "grid-current";
/** The single tree of the first prototype, taken over once. */
const OLD_KEY = "analysis-grid";

export interface SavedNode {
  uci: string | null;
  score: Score | null;
  analysed: 0 | 1 | 2;
  depth: number;
  origin: Origin;
  attention?: boolean;
  comment?: string;
  moveMark?: MoveMark | null;
  posMark?: PosMark | null;
  expanded: boolean;
  children: SavedNode[];
  /** A folded engine line. */
  ghost?: { ucis: string[]; score: Score | null };
  /** First prototype. */
  toCheck?: boolean;
}

export interface Analysis {
  id: string;
  name: string;
  /** ms since 1970 */
  updated: number;
  fen: string;
  chess960: boolean;
  tree: SavedNode;
  /** Number of boards, for the list. */
  boards: number;
}

export function newId(): string {
  return Date.now().toString(36).padStart(9, "0") + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

export async function listAnalyses(): Promise<Analysis[]> {
  const all = await loadAll<Analysis>(PREFIX);
  return all.sort((a, b) => b.updated - a.updated);
}

export function saveAnalysis(a: Analysis): Promise<void> {
  return Promise.all([save(PREFIX + a.id, a), save(CURRENT, a.id)]).then(() => {});
}

export function deleteAnalysis(id: string): Promise<void> {
  return removeAll(PREFIX + id);
}

/** The analysis open last time (or the first prototype's tree), if any. */
export async function currentAnalysis(): Promise<Analysis | null> {
  const id = await load<string>(CURRENT);
  if (id) {
    const a = await load<Analysis>(PREFIX + id);
    if (a) return a;
  }
  const old = await load<{ fen: string; chess960: boolean; tree: SavedNode }>(OLD_KEY);
  if (old) {
    const a: Analysis = { id: newId(), name: "First analysis", updated: Date.now(), boards: 0, ...old };
    await saveAnalysis(a);
    await save(OLD_KEY, undefined);
    return a;
  }
  return null;
}
