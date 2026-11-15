import assert from "node:assert/strict";
import { test } from "node:test";
import { placementFromFen } from "../chess/fen.ts";
import { features } from "./features.ts";
import { normalSan, parsePgn, writePgn } from "./pgn.ts";
import { describeWin, forcingEnd } from "./threat-text.ts";
import { assess, barFraction, chosenLine, hiddenLine, layout, type GNode } from "./tree.ts";

let id = 0;
function node(parent: GNode | null, san = "x", fen = ""): GNode {
  const n: GNode = {
    id: id++, uci: parent ? san : null, san, moveNo: "", fen, ply: parent ? parent.ply + 1 : 0, parent, children: [],
    state: "ongoing", lastMove: null, score: null, analysed: 0, depth: 0, origin: "seed", attention: false, comment: "",
    moveMark: null, posMark: null, expanded: true, ghost: null,
  };
  parent?.children.push(n);
  return n;
}

test("layout: first child continues the row, others start rows below, nearest branch first", () => {
  const root = node(null);
  const a1 = node(root);
  const a2 = node(a1);
  node(a2);
  const b1 = node(root); // branch at column 0
  const c2 = node(a1); // branch at column 1
  const { cells, rows, cols } = layout(root);
  assert.equal(cols, 4);
  assert.equal(rows.length, 3);
  // Row 1 is the branch nearer the end of row 0 (from a1), row 2 the one from the root.
  assert.equal(cells.find((c) => c.node === c2)!.row, 1);
  assert.equal(cells.find((c) => c.node === b1)!.row, 2);
  assert.equal(rows[1].startCol, 2);
  assert.equal(rows[2].from!.node, root);
  root.expanded = false;
  assert.equal(layout(root).rows.length, 2);
});

test("layout: a ghost ends its row, or gets a row of its own beside real children", () => {
  const ghost = { ucis: ["a", "b"], text: "", fen: "", san: "", moveNo: "", lastMove: null, state: "ongoing" as const, score: null };
  const root = node(null);
  const a = node(root);
  a.ghost = ghost;
  let l = layout(root);
  assert.equal(l.rows.length, 1);
  assert.deepEqual(l.cells.filter((c) => c.ghost).map((c) => [c.row, c.col]), [[0, 2]]);
  assert.equal(l.cols, 3);
  node(a); // a real move after a: the ghost moves to its own row
  l = layout(root);
  assert.equal(l.rows.length, 2);
  assert.deepEqual(l.cells.filter((c) => c.ghost).map((c) => [c.row, c.col]), [[1, 2]]);
  assert.equal(l.rows[1].from!.node, a);  // A locked analysis leaves ghosts out.
  l = layout(root, false);
  assert.equal(l.rows.length, 1);
  assert.equal(l.cells.filter((c) => c.ghost).length, 0);
});

test("bar: linear, ±8 pawns or a mate fill it", () => {
  assert.equal(barFraction({ cp: 0 }, "ongoing", true), 0);
  assert.equal(barFraction({ cp: 100 }, "ongoing", true), 0.125);
  assert.equal(barFraction({ cp: -400 }, "ongoing", true), -0.5);
  assert.equal(barFraction({ cp: 1200 }, "ongoing", true), 1);
  assert.equal(barFraction({ mate: -2 }, "ongoing", true), -1);
  assert.equal(barFraction(null, "checkmate", true), -1); // White to move and mated
});

test("features: extra material, weak and passed pawns by square, king danger", () => {
  // White has queen, knight and 6 pawns against 2 doubled, isolated black c-pawns; Black's
  // king has no shelter.
  const f = features(placementFromFen("6k1/8/2p5/2p5/8/8/PPP2PPP/3QKN2 w - - 0 1"));
  assert.equal(f.material, 9 + 3 + 6 - 2);
  assert.deepEqual(f.extra.white, ["Q", "N", "P", "P", "P", "P"]);
  assert.deepEqual(f.extra.black, []);
  assert.ok(f.weak.includes(34) && f.weak.includes(42)); // c5, c6
  // White's f2 has no black pawn in front of it: passed. b2 faces the c-pawns; Black's
  // c-pawns face White's b- and c-pawns.
  assert.ok(f.passed.some((p) => p.sq === 13 && p.white));
  assert.ok(!f.passed.some((p) => p.sq === 9));
  assert.ok(!f.passed.some((p) => !p.white));
  assert.ok(f.kings.find((k) => !k.white)!.danger >= 2);
  assert.ok(f.notes.some((n) => n.includes("doubled c-pawns")));
  const start = features(placementFromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"));
  assert.equal(start.material, 0);
  assert.deepEqual([start.weak, start.passed, start.kings.map((k) => k.danger)], [[], [], [0, 0]]);
});

test("pgn: variations, NAGs, suffix marks, comments, numbers stuck to moves", () => {
  const g = parsePgn(`[Event "Test"]
[FEN "8/8/8/8/8/8/8/8 w - - 0 1"]

{start} 1. e4 $1 e5?! {a comment [%attention]} (1... c5 $14 2. Nf3) 2.Nf3 Nc6 *`);
  assert.equal(g.tags.Event, "Test");
  assert.equal(g.root.comment, "start");
  const e4 = g.root.children[0];
  assert.equal(e4.san, "e4");
  assert.deepEqual(e4.nags, [1]);
  assert.equal(e4.children.length, 2);
  const [e5, c5] = e4.children;
  assert.deepEqual([e5.san, e5.nags, e5.comment], ["e5", [6], "a comment [%attention]"]);
  assert.deepEqual([c5.san, c5.nags, c5.children[0].san], ["c5", [14], "Nf3"]);
  assert.equal(e5.children[0].san, "Nf3");
  assert.equal(e5.children[0].children[0].san, "Nc6");
  assert.equal(normalSan("0-0+"), "O-O");
  assert.equal(normalSan("e8Q#"), "e8=Q");
});

test("pgn: writing numbers black moves after a comment or variation", () => {
  const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const root = node(null, "", start);
  const e4 = node(root, "e4", afterE4);
  const e5 = node(e4, "e5", "x w - - 0 2");
  node(e4, "c5", "x w - - 0 2");
  node(e5, "Nf3", "x b - - 1 2");
  e4.comment = "best";
  const text = writePgn([["Event", "T"]], root, (n) => ({ nags: n.san === "e5" ? [6] : [], comment: n.comment }));
  assert.equal(text, '[Event "T"]\n\n1. e4 {best} 1... e5 $6 (1... c5) 2. Nf3 *\n');
  // And back.
  const g = parsePgn(text);
  assert.deepEqual(g.root.children[0].children.map((m) => m.san), ["e5", "c5"]);
});

test("threat: follow the line while it is forcing", () => {
  const q = { capture: false, check: false };
  const x = { capture: true, check: false };
  const c = { capture: false, check: true };
  const xc = { capture: true, check: true };
  // 6. Nd5 Qf7 7. Nxc7+ Kd8 8. Nxa8 b6: on through the check and the capture after it.
  assert.equal(forcingEnd([q, q, xc, q, x, q]), 5);
  // A quiet threat and a quiet reply: two plies.
  assert.equal(forcingEnd([q, q, q]), 2);
  // A check keeps it going even if the next move is quiet.
  assert.equal(forcingEnd([q, c, q, q]), 3);
  assert.equal(forcingEnd([x]), 1);
});

test("threat: what it wins, as players say it", () => {
  const start = placementFromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  const black = (fen: string) => describeWin(start, placementFromFen(fen), false);
  // Black lost the a8 rook and the c7 pawn.
  assert.equal(black("1nbqkbnr/pp1ppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQk - 0 1"), "wins a rook and a pawn");
  // Black lost a rook, White a knight: the exchange.
  assert.equal(black("1nbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/R1BQKBNR w KQk - 0 1"), "wins the exchange");
  // Black lost a knight, White two pawns.
  assert.equal(black("r1bqkbnr/pppppppp/8/8/8/8/PPPPP2P/RNBQKBNR w KQkq - 0 1"), "wins a piece for two pawns");
  // A knight for a bishop is no win.
  assert.equal(black("r1bqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RN1QKBNR w KQkq - 0 1"), null);
});

test("assess: marks back up by minimax; open lines, attention and unclear block", () => {
  const W = "p w", B = "p b";
  const root = node(null, "r", W); // White to move
  const a = node(root, "a", B);
  const a1 = node(a, "a1", W);
  const a2 = node(a, "a2", W);
  const b = node(root, "b", B);
  a1.posMark = "+";
  a2.posMark = "0";
  let r = assess(root);
  // Black picks a2 (0); the root stays open while b has no mark.
  assert.equal(r.get(a)!.derived, "0");
  assert.deepEqual(r.get(a)!.best, [a2]);
  assert.equal(r.get(root)!.mark, null);
  b.posMark = "+/-";
  r = assess(root);
  assert.equal(r.get(root)!.derived, "+/-");
  assert.deepEqual(r.get(root)!.best, [b]);
  assert.equal(r.get(root)!.own, false);
  // A tie: both lines are best.
  b.posMark = "0";
  assert.deepEqual(assess(root).get(root)!.best, [a, b]);
  // The player's own mark wins, and is what goes up.
  a.posMark = "+";
  r = assess(root);
  assert.equal(r.get(a)!.mark, "+");
  assert.equal(r.get(a)!.derived, "0");
  assert.equal(r.get(root)!.derived, "+");
  // Needs attention: open until removed, even with a mark.
  a.attention = true;
  assert.equal(assess(root).get(root)!.mark, null);
  a.attention = false;
  // Unclear blocks too.
  b.posMark = "∞";
  assert.equal(assess(root).get(root)!.mark, null);
});

test("assess: checkmate and stalemate settle themselves; ghosts do not count", () => {
  const root = node(null, "r", "p b");
  const m = node(root, "m", "p w");
  m.state = "checkmate"; // White is mated
  const s = node(root, "s", "p w");
  s.state = "stalemate";
  root.ghost = { ucis: ["x"], text: "", fen: "", san: "", moveNo: "", lastMove: null, state: "ongoing", score: null };
  const r = assess(root);
  assert.equal(r.get(m)!.mark, "--");
  assert.equal(r.get(s)!.mark, "0");
  assert.equal(r.get(root)!.mark, "--");
  assert.deepEqual(r.get(root)!.best, [m]);
});

test("chosenLine: from the top of a settled part along the best moves, refuted lines left out", () => {
  const root = node(null, "r", "p w");
  const e4 = node(root, "e4", "p b");
  const e5 = node(e4, "e5", "p w");
  const nf3 = node(e5, "Nf3", "p b");
  const e6 = node(e4, "e6", "p w");
  const d4 = node(e6, "d4", "p b");
  nf3.posMark = "+";
  d4.posMark = "0";
  let line = chosenLine(root, assess(root));
  assert.deepEqual([...line].map((n) => n.san).sort(), ["d4", "e4", "e6"]);
  // With the root open (another line without a mark), the settled part below 1.e4 still
  // shows its choice.
  node(root, "c4", "p b");
  line = chosenLine(root, assess(root));
  assert.deepEqual([...line].map((n) => n.san).sort(), ["d4", "e6"]);
});

test("hidden line: one small board ends the row; its branches add up", () => {
  const root = node(null);
  const m1 = node(root, "m1");
  const m2 = node(m1, "m2");
  const m3 = node(m2, "m3");
  const m4 = node(m3, "m4");
  node(m2, "b1"); // two lines branch off at m2…
  node(m2, "b2");
  node(m4, "c1"); // …and one at m4 (m4's first child continues the line)
  node(m4, "c2");
  const other = node(root, "x");
  m1.hidden = true;
  const { cells, rows } = layout(root);
  // Row 0: root, then the hidden line as one cell; row 1: x. Nothing inside the hidden line.
  assert.equal(rows.length, 2);
  const folded = cells.filter((c) => c.folded);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].node, m1);
  assert.equal(folded[0].row, 0);
  assert.equal(folded[0].col, 1);
  assert.ok(!cells.some((c) => [m2, m3, m4].includes(c.node)));
  assert.ok(cells.some((c) => c.node === other && c.row === 1));
  const h = hiddenLine(m1);
  assert.equal(h.end.san, "c1");
  assert.equal(h.plies, 5); // m1 m2 m3 m4 c1
  assert.equal(h.branches, 3); // +2 at m2, +1 at m4
  // A hidden alternative: its row holds only the small board.
  m1.hidden = false;
  other.hidden = true;
  const l = layout(root);
  const row = l.cells.filter((c) => c.node === other);
  assert.equal(row.length, 1);
  assert.ok(row[0].folded);
});

test("assess: a move marked not needed is left out (a cutoff by hand)", () => {
  const root = node(null, "r", "p w"); // White to move
  const good = node(root, "good", "p b");
  const other = node(root, "other", "p b");
  good.posMark = "+";
  assert.equal(assess(root).get(root)!.mark, null); // "other" is open
  other.cut = true;
  const r = assess(root);
  assert.equal(r.get(root)!.mark, "+");
  assert.deepEqual(r.get(root)!.best, [good]);
  // Everything cut: nothing to go on.
  good.cut = true;
  assert.equal(assess(root).get(root)!.mark, null);
});
