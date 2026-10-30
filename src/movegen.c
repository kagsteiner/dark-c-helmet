#include "movegen.h"

static inline void add(MoveList* list, int from, int to, int flags) {
    list->moves[list->count].move = make_move(from, to, flags);
    list->moves[list->count].score = 0;
    list->count++;
}

static void add_promotions(MoveList* list, int from, int to, int capture, int type) {
    int cap = capture ? FLAG_CAPTURE : 0;
    if (type & GEN_NOISY) add(list, from, to, FLAG_PROMO | cap | (QUEEN - KNIGHT));
    if (type & GEN_QUIET) {
        add(list, from, to, FLAG_PROMO | cap | (KNIGHT - KNIGHT));
        add(list, from, to, FLAG_PROMO | cap | (BISHOP - KNIGHT));
        add(list, from, to, FLAG_PROMO | cap | (ROOK - KNIGHT));
    }
}

static void gen_pawn_moves(const Position* pos, MoveList* list, int type) {
    int us = pos->side, them = us ^ 1;
    int up = (us == WHITE) ? 8 : -8;
    Bitboard pawns = pieces_of(pos, us, PAWN);
    Bitboard rank7 = (us == WHITE) ? RANK_BB[6] : RANK_BB[1];
    Bitboard rank3 = (us == WHITE) ? RANK_BB[2] : RANK_BB[5];
    Bitboard empty = ~pos->occupied;
    Bitboard enemies = pos->by_color[them];
    Bitboard normal = pawns & ~rank7;
    Bitboard promoting = pawns & rank7;

    // Left capture = towards file a; its from-square offset depends on color.
    int left_off = (us == WHITE) ? 7 : -9;
    int right_off = (us == WHITE) ? 9 : -7;

    if (type & GEN_QUIET) {
        Bitboard single = pawn_push(us, normal) & empty;
        Bitboard dbl = pawn_push(us, single & rank3) & empty;
        while (single) { int to = pop_lsb(&single); add(list, to - up, to, FLAG_QUIET); }
        while (dbl) { int to = pop_lsb(&dbl); add(list, to - 2 * up, to, FLAG_DOUBLE_PUSH); }
    }

    if (type & GEN_NOISY) {
        Bitboard left = (us == WHITE ? (normal & ~FILE_A_BB) << 7 : (normal & ~FILE_A_BB) >> 9) & enemies;
        Bitboard right = (us == WHITE ? (normal & ~FILE_H_BB) << 9 : (normal & ~FILE_H_BB) >> 7) & enemies;
        while (left) { int to = pop_lsb(&left); add(list, to - left_off, to, FLAG_CAPTURE); }
        while (right) { int to = pop_lsb(&right); add(list, to - right_off, to, FLAG_CAPTURE); }

        int ep = pos->st->ep_sq;
        if (ep != NO_SQ) {
            Bitboard attackers = PAWN_ATTACKS[them][ep] & normal;
            while (attackers) add(list, pop_lsb(&attackers), ep, FLAG_EP);
        }
    }

    if (promoting) {
        Bitboard push = pawn_push(us, promoting) & empty;
        Bitboard left = (us == WHITE ? (promoting & ~FILE_A_BB) << 7 : (promoting & ~FILE_A_BB) >> 9) & enemies;
        Bitboard right = (us == WHITE ? (promoting & ~FILE_H_BB) << 9 : (promoting & ~FILE_H_BB) >> 7) & enemies;
        while (push) { int to = pop_lsb(&push); add_promotions(list, to - up, to, 0, type); }
        while (left) { int to = pop_lsb(&left); add_promotions(list, to - left_off, to, 1, type); }
        while (right) { int to = pop_lsb(&right); add_promotions(list, to - right_off, to, 1, type); }
    }
}

// Castling for standard chess and Chess960. The king ends on g1/c1 (g8/c8), the rook on f1/d1
// (f8/d8). Required: no check, the squares between king/rook and their targets empty (apart
// from the two pieces themselves), no attacked square on the king's way, and the king's
// target not attacked in the position after castling (in Chess960 the castling rook can
// shield the target before the move, or after it from its new square).
static void gen_castling(const Position* pos, MoveList* list) {
    int us = pos->side, them = us ^ 1;
    if (in_check(pos)) return;
    int ksq = king_square(pos, us);
    for (int queenside = 0; queenside <= 1; ++queenside) {
        int idx = castle_index(us, queenside);
        if (!(pos->st->castling & (1 << idx))) continue;
        if (pos->occupied & pos->castle_empty[idx]) continue;
        Bitboard transit = pos->castle_transit[idx];
        int attacked = 0;
        while (transit && !attacked) attacked = square_attacked(pos, pop_lsb(&transit), them, pos->occupied);
        if (attacked) continue;
        int king_to = relative_square(us, queenside ? C1 : G1);
        int rook_to = relative_square(us, queenside ? D1 : F1);
        Bitboard after = (pos->occupied ^ BB(ksq) ^ BB(pos->castle_rook[idx])) | BB(king_to) | BB(rook_to);
        if (square_attacked(pos, king_to, them, after)) continue;
        add(list, ksq, king_to, queenside ? FLAG_QUEEN_CASTLE : FLAG_KING_CASTLE);
    }
}

void generate_moves(const Position* pos, MoveList* list, int type) {
    list->count = 0;
    int us = pos->side, them = us ^ 1;
    Bitboard targets = 0;
    if (type & GEN_NOISY) targets |= pos->by_color[them];
    if (type & GEN_QUIET) targets |= ~pos->occupied;

    gen_pawn_moves(pos, list, type);

    for (int pt = KNIGHT; pt <= KING; ++pt) {
        Bitboard pieces = pieces_of(pos, us, pt);
        while (pieces) {
            int from = pop_lsb(&pieces);
            Bitboard attacks = piece_attacks(pt, from, pos->occupied) & targets;
            while (attacks) {
                int to = pop_lsb(&attacks);
                add(list, from, to, (pos->board[to] != NO_PIECE) ? FLAG_CAPTURE : FLAG_QUIET);
            }
        }
    }

    if (type & GEN_QUIET) gen_castling(pos, list);
}

void generate_castling(const Position* pos, MoveList* list) { gen_castling(pos, list); }

void generate_legal(const Position* pos, MoveList* list) {
    MoveList pseudo;
    generate_moves(pos, &pseudo, GEN_ALL);
    list->count = 0;
    for (int i = 0; i < pseudo.count; ++i) {
        if (pos_is_legal(pos, pseudo.moves[i].move)) list->moves[list->count++] = pseudo.moves[i];
    }
}
