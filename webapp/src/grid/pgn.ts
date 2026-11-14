// PGN for the analysis grid: one game with variations, comments and NAGs ($1 ... $19).
// Reading gives a tree of SAN moves; turning SAN into legal moves is left to the caller
// (it needs the rules). Writing takes the grid's tree.
import type { GNode } from "./tree.ts";

export interface PgnMove {
  san: string;
  nags: number[];
  comment: string;
  /** children[0] continues the line, the others are variations. */
  children: PgnMove[];
}

export interface PgnGame {
  tags: Record<string, string>;
  /** The position before the first move: its comment and NAGs. */
  root: PgnMove;
}

const SUFFIX_NAG: Record<string, number> = { "!": 1, "?": 2, "!!": 3, "??": 4, "!?": 5, "?!": 6 };

/** Reads the first game of a PGN text. */
export function parsePgn(text: string): PgnGame {
  const tags: Record<string, string> = {};
  const body = text.replace(/^\uFEFF/, "").replace(/\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]/g, (_, k: string, v: string) => {
    if (!(k in tags)) tags[k] = v.replace(/\\(.)/g, "$1");
    return " ";
  });
  const root: PgnMove = { san: "", nags: [], comment: "", children: [] };
  const parent = new Map<PgnMove, PgnMove>();
  let cur = root;
  const stack: PgnMove[] = [];
  const addComment = (m: PgnMove, c: string) => {
    const t = c.trim();
    if (t) m.comment = m.comment ? m.comment + " " + t : t;
  };
  const tokens = body.match(/\{[^}]*\}|;[^\n]*|\$\d+|\(|\)|1-0|0-1|1\/2-1\/2|\*|[^\s(){};$]+/g) ?? [];
  for (const tok of tokens) {
    if (tok.startsWith("{")) addComment(cur, tok.slice(1, -1));
    else if (tok.startsWith(";")) addComment(cur, tok.slice(1));
    else if (tok.startsWith("$")) cur.nags.push(Number(tok.slice(1)));
    else if (tok === "(") {
      stack.push(cur);
      cur = parent.get(cur) ?? root;
    } else if (tok === ")") cur = stack.pop() ?? cur;
    else if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) {
      if (!stack.length) break; // end of the game
    } else {
      // A move, maybe with its number in front ("5.d4", "5...exd4") and marks behind ("Nf3!?").
      const t = tok.replace(/^\d+\.*(…)?/, "");
      if (!t) continue; // only a move number
      const m = /^(.*?)([!?]{1,2})?$/.exec(t)!;
      if (!m[1]) {
        if (m[2] && SUFFIX_NAG[m[2]]) cur.nags.push(SUFFIX_NAG[m[2]]);
        continue;
      }
      const move: PgnMove = { san: m[1], nags: m[2] && SUFFIX_NAG[m[2]] ? [SUFFIX_NAG[m[2]]] : [], comment: "", children: [] };
      cur.children.push(move);
      parent.set(move, cur);
      cur = move;
    }
  }
  return { tags, root };
}

/** SAN as written by people and programs, made comparable: no check marks, "O" castling,
 *  "=" before a promotion piece. */
export function normalSan(s: string): string {
  return s
    .replace(/[+#]+$/, "")
    .replace(/^0-0-0$/, "O-O-O")
    .replace(/^0-0$/, "O-O")
    .replace(/e\.p\.$/, "")
    .replace(/^([a-h](?:x[a-h])?[18])([QRBN])$/, "$1=$2");
}

export interface Annotation {
  nags: number[];
  comment: string;
}

/** Writes the tree as PGN. `annotate` gives each node's NAGs and comment (for the root: the
 *  comment before the first move; NAGs are not allowed there). */
export function writePgn(tags: [string, string][], root: GNode, annotate: (n: GNode) => Annotation): string {
  const head = tags.map(([k, v]) => `[${k} "${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`).join("\n");
  const tokens: string[] = [];
  const rootNote = annotate(root);
  if (rootNote.comment) tokens.push(`{${clean(rootNote.comment)}}`);
  tokens.push(...line(root, true, annotate));
  tokens.push("*");
  return head + "\n\n" + wrap(tokens) + "\n";
}

function clean(comment: string): string {
  return comment.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

/** The moves after `from`: its first child's line, with the other children as variations. */
function line(from: GNode, numberFirst: boolean, annotate: (n: GNode) => Annotation): string[] {
  const out: string[] = [];
  let n = from;
  let needNumber = numberFirst;
  while (n.children.length) {
    const [main, ...alts] = n.children;
    needNumber = move(main, needNumber, out, annotate);
    for (const alt of alts) {
      const v: string[] = [];
      const after = move(alt, true, v, annotate);
      v.push(...line(alt, after, annotate));
      out.push("(" + v.join(" ") + ")");
      needNumber = true;
    }
    n = main;
  }
  return out;
}

/** Writes one move with its number, NAGs and comment. Returns whether the next move needs
 *  its number (after a comment). */
function move(n: GNode, needNumber: boolean, out: string[], annotate: (n: GNode) => Annotation): boolean {
  const [, side, , , , full] = n.parent!.fen.split(" ");
  if (side === "w") out.push(`${full}.`);
  else if (needNumber) out.push(`${full}...`);
  out.push(n.san);
  const a = annotate(n);
  for (const nag of a.nags) out.push(`$${nag}`);
  if (a.comment) {
    out.push(`{${clean(a.comment)}}`);
    return true;
  }
  return false;
}

function wrap(tokens: string[]): string {
  const lines: string[] = [];
  let cur = "";
  for (const t of tokens.join(" ").split(/ +/)) {
    if (cur && cur.length + 1 + t.length > 79) {
      lines.push(cur);
      cur = t;
    } else cur = cur ? cur + " " + t : t;
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}
