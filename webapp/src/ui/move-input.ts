// What clicks and drags on the board mean:
//   - click a piece, then a target square (or drag the piece there)
//   - click only the target square: if exactly one piece can move there, it does
//   - castling: king onto its own rook, or onto its target square when that is not also an
//     ordinary king move (in Chess960 a king can sometimes step there normally)
//   - promotion: a picker on the board
//   - premove (while the opponent thinks): select a piece, then a square it might reach; any
//     other click cancels it. It is checked and played once the opponent has moved.
import type { PieceCode, Placement } from "../chess/fen.ts";
import { isWhite } from "../chess/fen.ts";
import type { LegalMove } from "../chess/rules.ts";
import { premoveTargets } from "../play/premove.ts";
import type { Board, BoardInput, Highlights } from "./board.ts";

/** Does clicking `sq` mean move `m`? Castling via the rook square only when `viaRook`. */
export function reaches(legal: LegalMove[], m: LegalMove, sq: number, viaRook: boolean): boolean {
  if (!m.castle) return m.to === sq;
  if (viaRook && m.rook === sq) return true;
  // The king's target square, unless the king is already there or can also step there normally.
  return m.to === sq && m.to !== m.from && !legal.some((n) => n.from === m.from && !n.castle && n.to === sq);
}

/** The legal moves meant by moving the piece on `from` to `sq` (several for a promotion). */
export function movesBetween(legal: LegalMove[], from: number, sq: number): LegalMove[] {
  return legal.filter((m) => m.from === from && reaches(legal, m, sq, true));
}

export interface MoveInputOptions {
  /** Called with the chosen move in UCI notation. */
  onMove(uci: string): void;
  /** Target-only clicks (setting). */
  targetOnly(): boolean;
  /** A premove was set (from, to) or cleared (null). */
  onPremove?(premove: [number, number] | null): void;
}

/** "move": the player is to move. "premove": the opponent is, the player may premove. */
export type InputMode = "move" | "premove" | "off";

export class MoveInput implements BoardInput {
  private board: Board;
  private options: MoveInputOptions;
  private placement: Placement = new Array(64).fill(null);
  private legal: LegalMove[] = [];
  private whiteToMove = true;
  private mode: InputMode = "off";
  private premove: [number, number] | null = null;
  private base: Highlights = {};
  private selected: number | null = null;
  private wasSelected = false; // the pressed piece was already selected before this press

  constructor(board: Board, options: MoveInputOptions) {
    this.board = board;
    this.options = options;
    board.setInput(this);
  }

  /** New position. `base` holds the highlights that do not come from input (last move, check). */
  setPosition(placement: Placement, legal: LegalMove[], whiteToMove: boolean, base: Highlights): void {
    // A re-render of the same position keeps the selection.
    if (placement.join() !== this.placement.join() || whiteToMove !== this.whiteToMove) this.selected = null;
    this.placement = placement;
    this.legal = legal;
    this.whiteToMove = whiteToMove;
    this.base = base;
    this.render();
  }

  /** In "premove" mode, `whiteToMove` of setPosition is the opponent; the player has the other colour. */
  setMode(mode: InputMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== "premove") this.premove = null;
    this.selected = null;
    this.render();
  }

  clearPremove(): void {
    this.premove = null;
    this.render();
  }

  pointerDown(sq: number): boolean {
    if (this.mode === "premove") return this.premoveDown(sq);
    if (this.mode !== "move") return false;
    if (this.selected !== null) {
      const moves = this.movesTo(this.selected, sq);
      if (moves.length) {
        this.execute(moves);
        return false;
      }
    }
    if (this.isOwn(this.placement[sq])) {
      this.wasSelected = this.selected === sq;
      this.select(sq);
      return true;
    }
    if (this.selected !== null) {
      this.deselect();
      return false;
    }
    if (this.options.targetOnly()) {
      const moves = this.legal.filter((m) => this.reaches(m, sq, false));
      if (moves.length && moves.every((m) => m.from === moves[0].from)) this.execute(moves);
    }
    return false;
  }

  release(sq: number): void {
    if (sq === this.selected && this.wasSelected) this.deselect();
  }

  drop(from: number, to: number | null): void {
    if (to === null) return;
    if (this.mode === "premove") {
      if (premoveTargets(this.placement, from).includes(to)) this.setPremove([from, to]);
      return;
    }
    if (this.mode !== "move") return;
    const moves = this.movesTo(from, to);
    if (moves.length) this.execute(moves);
  }

  private premoveDown(sq: number): boolean {
    if (this.premove) this.setPremove(null); // any click cancels a premove
    if (this.selected !== null && premoveTargets(this.placement, this.selected).includes(sq)) {
      this.setPremove([this.selected, sq]);
      return false;
    }
    const piece = this.placement[sq];
    if (piece !== null && isWhite(piece) !== this.whiteToMove) {
      this.wasSelected = this.selected === sq;
      this.select(sq);
      return true;
    }
    this.deselect();
    return false;
  }

  private setPremove(premove: [number, number] | null): void {
    this.premove = premove;
    this.selected = null;
    this.options.onPremove?.(premove);
    this.render();
  }

  // --- helpers ---------------------------------------------------------------------------

  private isOwn(piece: PieceCode | null): boolean {
    return piece !== null && isWhite(piece) === this.whiteToMove;
  }

  private reaches(m: LegalMove, sq: number, viaRook: boolean): boolean {
    return reaches(this.legal, m, sq, viaRook);
  }

  private movesTo(from: number, sq: number): LegalMove[] {
    return movesBetween(this.legal, from, sq);
  }

  private execute(moves: LegalMove[]): void {
    this.deselect();
    if (moves.length === 1) {
      this.options.onMove(moves[0].uci);
      return;
    }
    // Several moves between the same squares: a promotion.
    this.board.choosePromotion(moves[0].to, this.whiteToMove).then((piece) => {
      const move = piece && moves.find((m) => m.promo === piece);
      if (move) this.options.onMove(move.uci);
    });
  }

  private select(sq: number): void {
    this.selected = sq;
    this.render();
  }

  private deselect(): void {
    if (this.selected === null) return;
    this.selected = null;
    this.render();
  }

  private render(): void {
    const h: Highlights = { ...this.base };
    if (this.premove) h.premove = this.premove;
    if (this.selected !== null && this.mode === "premove") {
      h.selected = this.selected;
      h.targets = premoveTargets(this.placement, this.selected);
    } else if (this.selected !== null) {
      const from = this.selected;
      const targets = new Set<number>();
      for (const m of this.legal) {
        if (m.from !== from) continue;
        if (!m.castle) targets.add(m.to);
        else {
          targets.add(m.rook);
          if (this.reaches(m, m.to, false)) targets.add(m.to);
        }
      }
      h.selected = from;
      h.targets = [...targets];
    }
    this.board.setHighlights(h);
  }
}
