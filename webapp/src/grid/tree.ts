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
export const POS_MARKS = ["++", "+", "+/-", "0", "-/+", "-", "--", "∞"] as const;
export type PosMark = (typeof POS_MARKS)[number];
export const POS_MARK_NAG: Record<PosMark, number> = {
  "++": 18, "+": 16, "+/-": 14, "0": 10, "-/+": 15, "-": 17, "--": 19, "∞": 13,
};
export const POS_MARK_TITLE: Record<PosMark, string> = {
  "++": "White is winning", "+": "White is clearly better", "+/-": "White is slightly better", "0": "equal",
  "-/+": "Black is slightly better", "-": "Black is clearly better", "--": "Black is winning", "∞": "unclear",
};
/** Bar length for the player's own assessment (when the engine is off). */
export const POS_MARK_BAR: Record<PosMark, number> = {
  "++": 1, "+": 0.66, "+/-": 0.33, "0": 0, "-/+": -0.33, "-": -0.66, "--": -1, "∞": 0,
};
/** Order of the marks for backing them up (higher is better for White); "unclear" has none. */
const POS_MARK_ORDER: Partial<Record<PosMark, number>> = { "++": 3, "+": 2, "+/-": 1, "0": 0, "-/+": -1, "-": -2, "--": -3 };

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
  /** Hidden by the player: this position and everything after it are drawn as one small
   *  board, the end of its line. */
  hidden?: boolean;
  /** Marked "not needed" by the player (a cutoff by hand): the move is not worth analysing,
   *  because another move already settles the position. The marks before it leave it out. */
  cut?: boolean;
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
  /** `node` is hidden: this cell stands for it and everything after it. */
  folded?: true;
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
      if (n.hidden) {
        // A hidden line ends the row: one small board for all of it.
        cells.push({ node: n, row, col: n.ply, folded: true });
        cols = Math.max(cols, n.ply + 1);
        break;
      }
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

/** What a hidden line holds: its end (along the first moves), how many moves lead there, and
 *  how many lines branch off on the way (the "+N" of every board on it, added up). */
export function hiddenLine(n: GNode, ghosts = true): { end: GNode; plies: number; branches: number } {
  let end = n;
  let plies = 1;
  let branches = alternatives(n, ghosts);
  while (end.children.length) {
    end = end.children[0];
    plies++;
    branches += alternatives(end, ghosts);
  }
  return { end, plies, branches };
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

/** A position's assessment as it follows from the player's marks. */
export interface Assessment {
  /** What the position is worth: the player's own mark, or else the one that follows. */
  mark: PosMark | null;
  /** `mark` is the player's own. */
  own: boolean;
  /** What follows from the lines after it (or from the game's end), whatever the own mark
   *  says; null while some line is open. */
  derived: PosMark | null;
  /** The children the derived value comes from: the best for the side to move (all of them
   *  on a tie). Empty when nothing is derived. */
  best: GNode[];
}

/** Backs up the player's position marks by minimax. A position counts as settled with its
 *  own mark, or when every line after it (folded engine lines and moves marked "not needed"
 *  aside) is settled: then it is worth the best of them for the side to move. Checkmate and stalemate settle themselves. A
 *  position marked "needs attention", or marked unclear, settles nothing above it. */
export function assess(root: GNode): Map<GNode, Assessment> {
  const out = new Map<GNode, Assessment>();
  /** The value passed up: the mark as a number, or null (open). */
  const visit = (n: GNode): number | null => {
    const all = n.children.map(visit); // every child, also below an open one
    // Moves marked "not needed" are left out.
    const kids = n.children.filter((c) => !c.cut);
    const values = all.filter((_, i) => !n.children[i].cut);
    let derived: PosMark | null = null;
    let best: GNode[] = [];
    if (n.state === "checkmate") derived = n.fen.split(" ")[1] === "w" ? "--" : "++";
    else if (n.state !== "ongoing") derived = "0";
    else if (values.length && values.every((v) => v !== null)) {
      const white = n.fen.split(" ")[1] === "w";
      const v = (white ? Math.max : Math.min)(...(values as number[]));
      best = kids.filter((_, i) => values[i] === v);
      derived = markOf(v);
    }
    const mark = n.posMark ?? derived;
    out.set(n, { mark, own: !!n.posMark, derived, best });
    if (n.attention || !mark) return null;
    return POS_MARK_ORDER[mark] ?? null;
  };
  visit(root);
  return out;
}

/** The positions on the line the marks choose, by the move that leads to them: from the top of
 *  each settled part of the tree (a settled position whose parent is open) along the best
 *  moves. Lines the marks refute are left out. */
export function chosenLine(root: GNode, marks: Map<GNode, Assessment>): Set<GNode> {
  const out = new Set<GNode>();
  const follow = (n: GNode) => {
    for (const c of marks.get(n)!.best) {
      out.add(c);
      follow(c);
    }
  };
  walk(root, (n) => {
    if (marks.get(n)!.best.length && !(n.parent && marks.get(n.parent)!.best.length)) follow(n);
  });
  return out;
}

function markOf(v: number): PosMark {
  return (Object.keys(POS_MARK_ORDER) as PosMark[]).find((m) => POS_MARK_ORDER[m] === v)!;
}
