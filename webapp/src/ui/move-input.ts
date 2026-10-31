// What clicks and drags on the board mean:
//   - click a piece, then a target square (or drag the piece there)
//   - click only the target square: if exactly one piece can move there, it does
//   - castling: king onto its own rook, or onto its target square when that is not also an
//     ordinary king move (in Chess960 a king can sometimes step there normally)
//   - promotion: a picker on the board
import type { PieceCode, Placement } from "../chess/fen.ts";
import { isWhite } from "../chess/fen.ts";
import type { LegalMove } from "../chess/rules.ts";
import type { Board, BoardInput, Highlights } from "./board.ts";

export interface MoveInputOptions {
  /** Called with the chosen move in UCI notation. */
  onMove(uci: string): void;
  /** Target-only clicks (setting). */
  targetOnly(): boolean;
}

export class MoveInput implements BoardInput {
  private board: Board;
  private options: MoveInputOptions;
  private placement: Placement = new Array(64).fill(null);
  private legal: LegalMove[] = [];
  private whiteToMove = true;
  private enabled = false;
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
    this.placement = placement;
    this.legal = legal;
    this.whiteToMove = whiteToMove;
    this.base = base;
    this.selected = null;
    this.render();
  }

  /** Whether the player may move now. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.deselect();
  }

  pointerDown(sq: number): boolean {
    if (!this.enabled) return false;
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
    if (!this.enabled || to === null) return;
    const moves = this.movesTo(from, to);
    if (moves.length) this.execute(moves);
  }

  // --- helpers ---------------------------------------------------------------------------

  private isOwn(piece: PieceCode | null): boolean {
    return piece !== null && isWhite(piece) === this.whiteToMove;
  }

  /** Does clicking `sq` mean move `m`? Castling via the rook square only when `viaRook`. */
  private reaches(m: LegalMove, sq: number, viaRook: boolean): boolean {
    if (!m.castle) return m.to === sq;
    if (viaRook && m.rook === sq) return true;
    // The king's target square, unless the king is already there or can also step there normally.
    return m.to === sq && m.to !== m.from && !this.legal.some((n) => n.from === m.from && !n.castle && n.to === sq);
  }

  private movesTo(from: number, sq: number): LegalMove[] {
    return this.legal.filter((m) => m.from === from && this.reaches(m, sq, true));
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
    if (this.selected !== null) {
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
