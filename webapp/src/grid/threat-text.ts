// Putting a threat into words: how far the threatened line is followed (as long as it is
// forcing), and what it wins, named the way players say it ("wins a rook and a pawn",
// "wins the exchange", "wins a piece for two pawns").
import type { PieceCode, Placement } from "../chess/fen.ts";

export interface LineMove {
  capture: boolean;
  check: boolean;
}

/** How many plies of the line to follow: at least the threat and the reply, then on while
 *  the play is forcing (a check, or a capture or check coming next). */
export function forcingEnd(moves: LineMove[]): number {
  for (let i = 1; i < moves.length; i++) {
    const next = moves[i + 1];
    if (!moves[i].check && !(next && (next.capture || next.check))) return i + 1;
  }
  return moves.length;
}

type Kind = "Q" | "R" | "M" | "P"; // M: a minor piece (knight or bishop)
const VALUE: Record<Kind, number> = { Q: 9, R: 5, M: 3, P: 1 };
const ORDER: Kind[] = ["Q", "R", "M", "P"];
const ONE: Record<Kind, string> = { Q: "the queen", R: "a rook", M: "a piece", P: "a pawn" };
const MANY: Record<Kind, string> = { Q: "queens", R: "rooks", M: "pieces", P: "pawns" };
const NUMBER = ["", "", "two", "three", "four", "five", "six", "seven", "eight"];

function kindOf(p: PieceCode): Kind | null {
  const t = p.toUpperCase();
  return t === "Q" ? "Q" : t === "R" ? "R" : t === "N" || t === "B" ? "M" : t === "P" ? "P" : null;
}

function count(board: Placement, white: boolean): Record<Kind, number> {
  const c: Record<Kind, number> = { Q: 0, R: 0, M: 0, P: 0 };
  for (const p of board) {
    if (!p || (p === p.toUpperCase()) !== white) continue;
    const k = kindOf(p);
    if (k) c[k]++;
  }
  return c;
}

function list(c: Record<Kind, number>): string {
  const parts = ORDER.filter((k) => c[k] > 0).map((k) => (c[k] === 1 ? ONE[k] : `${NUMBER[c[k]] ?? c[k]} ${MANY[k]}`));
  return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0] ?? "";
}

/** What the threatening side wins between `before` and `after`, or null if it wins no
 *  material. `victimWhite`: the side that is threatened. */
export function describeWin(before: Placement, after: Placement, victimWhite: boolean): string | null {
  const vb = count(before, victimWhite);
  const va = count(after, victimWhite);
  const tb = count(before, !victimWhite);
  const ta = count(after, !victimWhite);
  const won = { Q: 0, R: 0, M: 0, P: 0 } as Record<Kind, number>;
  const given = { Q: 0, R: 0, M: 0, P: 0 } as Record<Kind, number>;
  let promoted = false;
  for (const k of ORDER) {
    won[k] = vb[k] - va[k];
    given[k] = tb[k] - ta[k];
    if (won[k] < 0 || given[k] < 0) promoted = true; // a piece appeared: a promotion
    // Equal trades cancel out ("a knight for a bishop" is no win).
    const trade = Math.min(Math.max(won[k], 0), Math.max(given[k], 0));
    won[k] -= trade;
    given[k] -= trade;
  }
  const value = (c: Record<Kind, number>) => ORDER.reduce((s, k) => s + c[k] * VALUE[k], 0);
  const net = value(won) - value(given);
  if (net <= 0) return null;
  if (promoted) return `wins material (about ${net} pawns)`;
  // A rook for a minor piece: the exchange (plus whatever else).
  if (won.R >= 1 && given.M >= 1) {
    won.R--;
    given.M--;
    const rest = list(won);
    const back = list(given);
    return "wins the exchange" + (rest ? ` and ${rest}` : "") + (back ? ` for ${back}` : "");
  }
  const back = list(given);
  return `wins ${list(won)}` + (back ? ` for ${back}` : "");
}
