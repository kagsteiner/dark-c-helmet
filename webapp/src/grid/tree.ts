// The analysis tree of the grid view and its layout: columns are plies from the root, rows
// are lines. A node's first child continues its row; every other child starts a new row
// below, beginning in the next column (like a subway map).
import type { GameState } from "../chess/rules.ts";

/** From White's point of view: centipawns, or mate in N moves (positive: White mates). */
export type Score = { cp: number } | { mate: number };

export type Origin = "seed" | "user" | "engine";

/** The player's mark for the move that led to a position. */
export const MOVE_MARKS = ["!!", "!", "!?", "?!", "?", "??"] as const;
export type MoveMark = (typeof MOVE_MARKS)[number];
export const MOVE_MARK_NAG: Record<MoveMark, number> = { "!": 1, "?": 2, "!!": 3, "??": 4, "!?": 5, "?!": 6 };
export const MOVE_MARK_TITLE: Record<MoveMark, string> = {
  "!!": "brilliant move", "!": "good move", "!?": "interesting move", "?!": "dubious move", "?": "mistake", "??": "blunder",
};

/** The player's assessment of a position, from White's point of view. */
export const POS_MARKS = ["++", "+", "+/-", "0", "-/+", "-", "--"] as const;
export type PosMark = (typeof POS_MARKS)[number];
export const POS_MARK_NAG: Record<PosMark, number> = { "++": 18, "+": 16, "+/-": 14, "0": 10, "-/+": 15, "-": 17, "--": 19 };
export const POS_MARK_TITLE: Record<PosMark, string> = {
  "++": "White is winning", "+": "White is clearly better", "+/-": "White is slightly better", "0": "equal",
  "-/+": "Black is slightly better", "-": "Black is clearly better", "--": "Black is winning",
};
/** Bar length for the player's own assessment (when the engine is off). */
export const POS_MARK_BAR: Record<PosMark, number> = { "++": 1, "+": 0.66, "+/-": 0.33, "0": 0, "-/+": -0.33, "-": -0.66, "--": -1 };

/** An engine line added with a suggestion, still folded: only its final position is drawn
 *  (faded, dashed). It keeps the line it was added with and unfolds only on request. */
export interface Ghost {
  ucis: string[];
  /** The moves in SAN with numbers, for the tooltip. */
  text: string;
  /** The final position. */
  fen: string;
  san: string;
  moveNo: string;
  lastMove: [number, number] | null;
  state: GameState;
  /** The engine's evaluation when the line was added. */
  score: Score | null;
}

export interface GNode {
  id: number;
  /** The move that led here (null for the root). */
  uci: string | null;
  san: string;
  /** e.g. "5." or "5…" */
  moveNo: string;
  fen: string;
  /** Column: plies from the root. */
  ply: number;
  parent: GNode | null;
  children: GNode[];
  state: GameState;
  lastMove: [number, number] | null;
  score: Score | null;
  /** 0 not analysed, 1 quick look, 2 deep. */
  analysed: 0 | 1 | 2;
  depth: number;
  origin: Origin;
  /** Marked by the player: this position needs attention (a coloured border). With the
   *  engine on, it also gets a deep search. */
  attention: boolean;
  comment: string;
  moveMark: MoveMark | null;
  posMark: PosMark | null;
  /** Alternatives (children after the first) shown as rows. */
  expanded: boolean;
  /** A folded engine line after this position. */
  ghost: Ghost | null;
  /** What the opponent threatens (engine, null move): undefined not looked at yet, null none. */
  threat?: Threat | null;
}

export interface Threat {
  from: number;
  to: number;
  /** The threatened line in SAN, with move numbers. */
  text: string;
  /** Mate in N for the opponent, or null. */
  mate: number | null;
  /** What the threatened line wins, in words ("wins a rook and a pawn"); null for a mate. */
  win: string | null;
}

export interface Cell {
  node: GNode;
  row: number;
  col: number;
  /** This cell is `node`'s ghost (its folded engine line), not the node. */
  ghost?: true;
}

/** Alternatives shown by a node's badge: other children, and a ghost beside real children
 *  (when ghosts are shown). */
export function alternatives(n: GNode, ghosts = true): number {
  return Math.max(0, n.children.length - 1) + (ghosts && n.ghost && n.children.length ? 1 : 0);
}

export interface Row {
  row: number;
  startCol: number;
  /** The board this row branches from (null for the first row). */
  from: Cell | null;
}

export interface Layout {
  cells: Cell[];
  rows: Row[];
  cols: number;
}

/** `ghosts`: false leaves folded engine lines out (a locked analysis). */
export function layout(root: GNode, ghosts = true): Layout {
  const cells: Cell[] = [];
  const rows: Row[] = [];
  let cols = 0;
  const emit = (start: GNode, from: Cell | null) => {
    const row = rows.length;
    rows.push({ row, startCol: start.ply, from });
    const line: Cell[] = [];
    for (let n: GNode = start; ; n = n.children[0]) {
      const c = { node: n, row, col: n.ply };
      cells.push(c);
      line.push(c);
      cols = Math.max(cols, n.ply + 1);
      if (!n.children.length) {
        // A ghost at the end of a row continues it.
        if (ghosts && n.ghost) {
          cells.push({ node: n, row, col: n.ply + 1, ghost: true });
          cols = Math.max(cols, n.ply + 2);
        }
        break;
      }
    }
    // Branches nearest the end of the row first: their connectors never cross other rows.
    for (let i = line.length - 1; i >= 0; i--) {
      const c = line[i];
      if (!c.node.expanded) continue;
      // A ghost beside real children gets a row of its own, like an alternative.
      if (ghosts && c.node.ghost && c.node.children.length) {
        const r = rows.length;
        rows.push({ row: r, startCol: c.node.ply + 1, from: c });
        cells.push({ node: c.node, row: r, col: c.node.ply + 1, ghost: true });
        cols = Math.max(cols, c.node.ply + 2);
      }
      for (const alt of c.node.children.slice(1)) emit(alt, c);
    }
  };
  emit(root, null);
  return { cells, rows, cols };
}

export function walk(n: GNode, f: (n: GNode) => void): void {
  f(n);
  for (const c of n.children) walk(c, f);
}

/** Evaluation that fills the bar completely (pawns). */
export const BAR_FULL = 8;

/** Bar position from -1 (all black) through 0 (half white, half black) to 1 (all white):
 *  linear, ±8 pawns or a mate fill it. */
export function barFraction(score: Score | null, state: GameState, whiteToMove: boolean): number {
  if (state === "checkmate") return whiteToMove ? -1 : 1;
  if (state !== "ongoing") return 0;
  if (!score) return 0;
  if ("mate" in score) return score.mate > 0 ? 1 : -1;
  return Math.max(-1, Math.min(1, score.cp / (BAR_FULL * 100)));
}

export function scoreText(score: Score | null, state: GameState): string {
  if (state === "checkmate") return "#";
  if (state !== "ongoing") return "½";
  if (!score) return "";
  if ("mate" in score) return (score.mate > 0 ? "+M" : "−M") + Math.abs(score.mate);
  const v = score.cp / 100;
  return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1);
}

/** White's point of view from a score of the side to move. */
export function whiteScore(s: { cp: number } | { mate: number }, whiteToMove: boolean): Score {
  const sign = whiteToMove ? 1 : -1;
  return "mate" in s ? { mate: sign * s.mate } : { cp: sign * s.cp };
}

/** For sorting: higher is better for White. */
export function scoreValue(s: Score | null): number {
  if (!s) return 0;
  if ("mate" in s) return s.mate > 0 ? 100000 - s.mate : -100000 - s.mate;
  return s.cp;
}
