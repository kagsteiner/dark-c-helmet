#include "eval.h"
#ifndef TUNE
#include "nnue.h"
#endif

#include <stdio.h>
#include <string.h>

// Hand-crafted tapered evaluation. Every weight lives in P (see eval.h) so that it can be
// fitted with the Texel tuner (tools/tune). Starting values for material and piece-square
// tables are PeSTO's (Ronald Friederich); they are loaded once and replaced by tuned values.

#define ALL_PIECES 6  // index into attacked[] for "attacked by any piece"

EvalParams P = {
    .material = {S(89, 85), S(361, 291), S(375, 311), S(505, 519), S(1038, 925), S(0, 0)},
    .psqt = {
        {
            S(0, 0), S(0, 0), S(0, 0), S(0, 0), S(0, 0), S(0, 0), S(0, 0), S(0, 0), 
            S(-29, 30), S(10, 11), S(-15, 23), S(-20, 12), S(-11, 16), S(16, 17), S(37, 9), S(-21, 10), 
            S(-18, 14), S(3, 6), S(0, 0), S(-11, 1), S(0, 9), S(1, 8), S(27, -6), S(-13, 4), 
            S(-18, 22), S(-5, 22), S(6, -4), S(9, -6), S(11, -2), S(10, -3), S(3, 1), S(-21, 10), 
            S(-6, 28), S(8, 21), S(3, 6), S(17, 5), S(15, 4), S(13, -5), S(11, 9), S(-18, 16), 
            S(-9, 71), S(6, 76), S(21, 75), S(30, 53), S(57, 42), S(54, 48), S(26, 68), S(-14, 74), 
            S(96, 162), S(131, 167), S(63, 162), S(94, 134), S(70, 148), S(126, 130), S(33, 162), S(-14, 175), 
            S(0, 0), S(0, 0), S(0, 0), S(0, 0), S(0, 0), S(0, 0), S(0, 0), S(0, 0)
        },
        {
            S(-106, -29), S(-19, -48), S(-55, -21), S(-33, -15), S(-13, -21), S(-24, -18), S(-13, -51), S(-24, -64), 
            S(-29, -41), S(-46, -16), S(-9, -9), S(-2, -6), S(6, -5), S(16, -19), S(-16, -25), S(-16, -43), 
            S(-19, -25), S(-13, -7), S(2, -2), S(13, 15), S(21, 9), S(17, -5), S(25, -17), S(-10, -21), 
            S(-8, -17), S(3, -8), S(14, 14), S(12, 22), S(34, 18), S(21, 16), S(21, -1), S(1, -13), 
            S(-7, -17), S(13, 2), S(21, 26), S(46, 19), S(32, 18), S(60, 10), S(15, 8), S(25, -16), 
            S(-45, -22), S(53, -20), S(41, 9), S(60, 9), S(80, -1), S(122, -14), S(71, -17), S(45, -40), 
            S(-69, -23), S(-39, -5), S(70, -28), S(37, -1), S(23, -10), S(62, -23), S(8, -21), S(-17, -51), 
            S(-163, -55), S(-89, -38), S(-34, -12), S(-48, -25), S(61, -29), S(-97, -26), S(-15, -63), S(-107, -98)
        },
        {
            S(-30, -23), S(1, -13), S(-7, -22), S(-16, -2), S(-11, -5), S(-7, -15), S(-38, -5), S(-25, -18), 
            S(7, -16), S(18, -15), S(19, -8), S(2, 3), S(12, 4), S(22, -15), S(31, -9), S(2, -26), 
            S(9, -6), S(18, -1), S(14, 9), S(12, 10), S(14, 14), S(20, 0), S(16, -8), S(9, -13), 
            S(-1, -5), S(12, 3), S(18, 14), S(25, 13), S(32, 7), S(8, 5), S(9, -5), S(4, -9), 
            S(-4, -1), S(5, 7), S(16, 8), S(44, 6), S(27, 12), S(36, 9), S(5, 6), S(-6, -1), 
            S(-14, 4), S(32, -9), S(40, -3), S(40, -3), S(35, 0), S(47, 5), S(37, 3), S(4, 4), 
            S(-23, -6), S(14, -3), S(-16, 6), S(-10, -6), S(27, -5), S(58, -10), S(18, -1), S(-46, -14), 
            S(-29, -12), S(4, -19), S(-82, -10), S(-37, -7), S(-25, -5), S(-43, -10), S(7, -17), S(-9, -24)
        },
        {
            S(-17, -5), S(-8, -6), S(0, -5), S(10, -6), S(16, -17), S(3, -12), S(-44, 10), S(-7, -23), 
            S(-33, -9), S(-11, -15), S(-17, 0), S(-11, -7), S(-7, -13), S(-4, -19), S(-9, -9), S(-68, -2), 
            S(-37, -1), S(-25, 0), S(-15, 0), S(-19, -3), S(-5, -10), S(-4, -17), S(-11, -9), S(-29, -13), 
            S(-31, 9), S(-26, 5), S(-11, 9), S(-2, 5), S(7, -3), S(-7, -5), S(2, -6), S(-21, -7), 
            S(-21, 13), S(-3, 5), S(8, 12), S(30, 6), S(25, 1), S(34, 1), S(-5, 2), S(-18, 5), 
            S(0, 17), S(24, 8), S(27, 11), S(38, 7), S(22, 12), S(49, 3), S(60, -2), S(15, 4), 
            S(28, 16), S(30, 8), S(55, 10), S(63, 11), S(79, -5), S(66, 4), S(27, 14), S(39, 7), 
            S(31, 10), S(39, 1), S(34, 20), S(50, 9), S(61, 6), S(11, 16), S(32, 12), S(41, 5)
        },
        {
            S(-1, -35), S(-17, -28), S(-4, -23), S(10, -51), S(-15, -8), S(-23, -31), S(-30, -20), S(-48, -41), 
            S(-33, -22), S(-2, -22), S(15, -32), S(7, -18), S(9, -14), S(12, -22), S(-3, -37), S(0, -31), 
            S(-15, -17), S(3, -25), S(-15, 16), S(1, 5), S(-3, 9), S(0, 17), S(3, 10), S(-2, 3), 
            S(1, -19), S(-28, 27), S(-11, 20), S(-3, 47), S(1, 30), S(-7, 31), S(-6, 36), S(-3, 24), 
            S(-24, 5), S(-24, 24), S(-14, 25), S(-14, 44), S(1, 56), S(15, 39), S(-2, 57), S(-3, 36), 
            S(-11, -19), S(-12, 7), S(9, 10), S(8, 49), S(28, 46), S(58, 35), S(43, 20), S(51, 8), 
            S(-22, -15), S(-37, 23), S(-5, 32), S(2, 40), S(-15, 59), S(56, 25), S(29, 30), S(50, 0), 
            S(-27, -7), S(0, 22), S(30, 22), S(12, 27), S(58, 25), S(44, 19), S(43, 10), S(42, 20)
        },
        {
            S(-13, -47), S(39, -28), S(14, -11), S(-56, -7), S(-6, -19), S(-26, -6), S(38, -25), S(20, -39), 
            S(8, -21), S(11, -2), S(-8, 0), S(-58, 13), S(-44, 14), S(-19, 8), S(8, -2), S(12, -16), 
            S(-12, -15), S(-12, 4), S(-25, 10), S(-45, 19), S(-43, 23), S(-33, 16), S(-14, 8), S(-29, -12), 
            S(-48, -12), S(0, 1), S(-28, 22), S(-40, 23), S(-48, 24), S(-44, 22), S(-33, 8), S(-51, -11), 
            S(-16, -4), S(-19, 30), S(-14, 23), S(-29, 27), S(-31, 25), S(-27, 21), S(-15, 20), S(-37, -2), 
            S(-8, 11), S(24, 20), S(2, 26), S(-17, 17), S(-21, 18), S(2, 27), S(17, 17), S(-23, 11), 
            S(30, -11), S(-1, 19), S(-20, 15), S(-7, 17), S(-9, 15), S(-9, 28), S(-37, 21), S(-29, 8), 
            S(-66, -77), S(23, -34), S(16, -18), S(-15, -18), S(-56, -11), S(-34, 14), S(2, 3), S(12, -21)
        },
    },
    .bishop_pair = S(39, 45),
    .doubled_pawn = S(-11, -7),
    .isolated_pawn = S(-4, -13),
    .backward_pawn = S(-7, -15),
    .passed_pawn = {S(0, 0), S(-4, 17), S(-3, 24), S(-2, 37), S(20, 45), S(37, 61), S(66, 106), S(0, 0)},
    .passed_king_dist_us = {S(0, 0), S(2, -1), S(3, -5), S(4, -11), S(-2, -12), S(1, -19), S(2, -25), S(0, 0)},
    .passed_king_dist_them = {S(0, 0), S(-2, 4), S(-4, 6), S(-3, 16), S(1, 22), S(4, 27), S(7, 10), S(0, 0)},
    .passed_blocked = {S(0, 0), S(-3, 1), S(-1, 1), S(-7, -4), S(-4, -12), S(-10, -21), S(-12, -37), S(0, 0)},
    .connected_pawn = {S(0, 0), S(4, 0), S(9, 6), S(12, 8), S(15, 16), S(30, 13), S(31, 26), S(0, 0)},
    .knight_mobility = {
        S(-22, -19), S(-11, -17), S(-5, -4), S(1, 3), S(5, 9), 
        S(10, 12), S(14, 15), S(18, 12), S(13, 0)
    },
    .bishop_mobility = {
        S(-32, -35), S(-24, -29), S(-11, -20), S(-7, -15), S(-2, -4), 
        S(3, 7), S(8, 10), S(8, 14), S(11, 14), S(12, 19), 
        S(14, 16), S(14, 20), S(21, 25), S(22, 27)
    },
    .rook_mobility = {
        S(-51, -34), S(-16, -32), S(-5, -25), S(-4, -16), S(-1, -12), 
        S(2, -5), S(0, 2), S(7, 5), S(8, 8), S(11, 18), 
        S(10, 19), S(15, 23), S(14, 23), S(15, 28), S(21, 6)
    },
    .queen_mobility = {
        S(-13, -26), S(-12, -24), S(-17, -22), S(-9, -21), S(-12, -20), 
        S(-12, -17), S(-11, -20), S(-9, -15), S(-5, -10), S(-3, -7), 
        S(-1, -4), S(1, -1), S(2, 0), S(4, 6), S(6, 7), 
        S(7, 11), S(8, 10), S(10, 13), S(9, 13), S(8, 15), 
        S(7, 12), S(7, 10), S(9, 15), S(7, 9), S(10, 18), 
        S(9, 15), S(13, 25), S(13, 24)
    },
    .rook_open_file = S(33, -2),
    .rook_semi_open_file = S(13, 17),
    .knight_outpost = S(24, 22),
    .bishop_outpost = S(17, 5),
    .king_zone_attack = {S(0, 0), S(6, -1), S(5, 2), S(13, -4), S(15, -4), S(0, 0)},
    .safe_check = {S(0, 0), S(30, 0), S(11, 12), S(45, -2), S(34, -30), S(0, 0)},
    .king_shield = {S(9, -8), S(3, -8)},
    .king_open_file = S(-16, -8),
    .threat_by_pawn = {S(0, 0), S(46, 20), S(43, 22), S(52, 20), S(45, 19), S(0, 0)},
    .threat_by_minor = {S(0, 0), S(17, 19), S(25, 17), S(40, 14), S(32, 20), S(0, 0)},
    .threat_by_rook = {S(0, 0), S(10, 11), S(14, 6), S(0, 1), S(36, 12), S(0, 0)},
    .hanging = S(18, 29),
    .tempo = S(17, 7),
};

int PSQ_MG[12][64];
int PSQ_EG[12][64];

#ifdef TUNE
EvalTrace T;
#define TRACE(field, color, n) (T.coeff[(Score*)&(field) - (Score*)&P][color] += (n))
#else
#define TRACE(field, color, n) ((void)0)
#endif

void eval_init(void) {
    for (int pt = PAWN; pt <= KING; ++pt) {
        for (int sq = 0; sq < 64; ++sq) {
            Score w = P.material[pt] + P.psqt[pt][sq];
            Score b = P.material[pt] + P.psqt[pt][sq ^ 56];
            PSQ_MG[make_piece(WHITE, pt)][sq] = mg_value(w);
            PSQ_EG[make_piece(WHITE, pt)][sq] = eg_value(w);
            PSQ_MG[make_piece(BLACK, pt)][sq] = -mg_value(b);
            PSQ_EG[make_piece(BLACK, pt)][sq] = -eg_value(b);
        }
    }
}

// ---------------------------------------------------------------------------
// Pawn structure (cached by pawn hash outside the tuner)
// ---------------------------------------------------------------------------

typedef struct {
    uint64_t key;
    Score score;          // white's view
    Bitboard passed[2];
} PawnEntry;

#define PAWN_TABLE_SIZE 16384
static PawnEntry pawn_table[PAWN_TABLE_SIZE];

static Score eval_pawns(const Position* pos, int us, Bitboard* passed) {
    int them = us ^ 1;
    Score score = 0;
    Bitboard ours = pieces_of(pos, us, PAWN), theirs = pieces_of(pos, them, PAWN);
    Bitboard our_attacks = pawn_attacks_bb(us, ours);
    Bitboard their_attacks = pawn_attacks_bb(them, theirs);
    Bitboard b = ours;
    *passed = 0;
    while (b) {
        int sq = pop_lsb(&b);
        int f = file_of(sq), r = relative_rank(us, sq);
        Bitboard adjacent = ADJACENT_FILES_BB[f];

        if (FORWARD_FILE_BB[us][sq] & ours) {
            score += P.doubled_pawn;
            TRACE(P.doubled_pawn, us, 1);
        }
        if (!(adjacent & ours)) {
            score += P.isolated_pawn;
            TRACE(P.isolated_pawn, us, 1);
        } else {
            // Backward: no own pawn on adjacent files level or behind, and the stop square is
            // controlled by an enemy pawn.
            int stop = sq + (us == WHITE ? 8 : -8);
            Bitboard behind = adjacent & ~PASSED_MASK[us][sq] & ~RANK_BB[rank_of(sq)] ;
            Bitboard level_or_behind = (behind | (adjacent & RANK_BB[rank_of(sq)])) & ours;
            if (!level_or_behind && (BB(stop) & their_attacks)) {
                score += P.backward_pawn;
                TRACE(P.backward_pawn, us, 1);
            }
        }
        if (!(PASSED_MASK[us][sq] & theirs) && !(FORWARD_FILE_BB[us][sq] & ours)) {
            *passed |= BB(sq);
            score += P.passed_pawn[r];
            TRACE(P.passed_pawn[r], us, 1);
        }
        // Connected: defended by a pawn, or side by side with one.
        Bitboard phalanx = adjacent & RANK_BB[rank_of(sq)] & ours;
        if ((our_attacks & BB(sq)) || phalanx) {
            score += P.connected_pawn[r];
            TRACE(P.connected_pawn[r], us, 1);
        }
    }
    return score;
}

static Score pawn_structure(const Position* pos, Bitboard passed[2]) {
#ifndef TUNE
    PawnEntry* e = &pawn_table[pos->st->pawn_key & (PAWN_TABLE_SIZE - 1)];
    if (e->key == pos->st->pawn_key) {
        passed[0] = e->passed[0];
        passed[1] = e->passed[1];
        return e->score;
    }
#endif
    Score s = eval_pawns(pos, WHITE, &passed[WHITE]) - eval_pawns(pos, BLACK, &passed[BLACK]);
#ifndef TUNE
    e->key = pos->st->pawn_key;
    e->score = s;
    e->passed[0] = passed[0];
    e->passed[1] = passed[1];
#endif
    return s;
}

// ---------------------------------------------------------------------------
// Pieces, king safety, threats
// ---------------------------------------------------------------------------

typedef struct {
    Bitboard attacked[2][7];   // by piece type, [ALL_PIECES] = any
    Bitboard attacked2[2];     // squares attacked at least twice
    Bitboard mobility_area[2];
    Bitboard king_zone[2];
} EvalInfo;

static inline void add_attacks(EvalInfo* ei, int c, int pt, Bitboard attacks) {
    ei->attacked2[c] |= ei->attacked[c][ALL_PIECES] & attacks;
    ei->attacked[c][pt] |= attacks;
    ei->attacked[c][ALL_PIECES] |= attacks;
}

static Score eval_pieces(const Position* pos, EvalInfo* ei, int us) {
    int them = us ^ 1;
    Score score = 0;
    Bitboard occ = pos->occupied;
    Bitboard our_pawns = pieces_of(pos, us, PAWN), their_pawns = pieces_of(pos, them, PAWN);
    // Outpost squares: relative ranks 4-6, defended by our pawn, never attackable by theirs.
    Bitboard outpost_ranks = us == WHITE ? (RANK_BB[3] | RANK_BB[4] | RANK_BB[5]) : (RANK_BB[2] | RANK_BB[3] | RANK_BB[4]);

    for (int pt = KNIGHT; pt <= QUEEN; ++pt) {
        Bitboard pieces = pieces_of(pos, us, pt);
        while (pieces) {
            int sq = pop_lsb(&pieces);
            Bitboard attacks = piece_attacks(pt, sq, occ);
            // Pinned pieces only move along the pin line.
            if (pos->side == us && (pos->st->pinned & BB(sq))) attacks &= LINE_BB[king_square(pos, us)][sq];
            add_attacks(ei, us, pt, attacks);

            int mob = popcount(attacks & ei->mobility_area[us]);
            switch (pt) {
                case KNIGHT: score += P.knight_mobility[mob]; TRACE(P.knight_mobility[mob], us, 1); break;
                case BISHOP: score += P.bishop_mobility[mob]; TRACE(P.bishop_mobility[mob], us, 1); break;
                case ROOK:   score += P.rook_mobility[mob];   TRACE(P.rook_mobility[mob], us, 1); break;
                default:     score += P.queen_mobility[mob];  TRACE(P.queen_mobility[mob], us, 1); break;
            }

            int zone_hits = popcount(attacks & ei->king_zone[them]);
            if (zone_hits) {
                score += P.king_zone_attack[pt] * zone_hits;
                TRACE(P.king_zone_attack[pt], us, zone_hits);
            }

            if ((pt == KNIGHT || pt == BISHOP) && (BB(sq) & outpost_ranks) &&
                (ei->attacked[us][PAWN] & BB(sq)) && !(PASSED_MASK[us][sq] & ~FILE_BB[file_of(sq)] & their_pawns)) {
                if (pt == KNIGHT) { score += P.knight_outpost; TRACE(P.knight_outpost, us, 1); }
                else { score += P.bishop_outpost; TRACE(P.bishop_outpost, us, 1); }
            }
            if (pt == ROOK && !(FILE_BB[file_of(sq)] & our_pawns)) {
                if (!(FILE_BB[file_of(sq)] & their_pawns)) { score += P.rook_open_file; TRACE(P.rook_open_file, us, 1); }
                else { score += P.rook_semi_open_file; TRACE(P.rook_semi_open_file, us, 1); }
            }
        }
    }
    if (more_than_one(pieces_of(pos, us, BISHOP))) {
        score += P.bishop_pair;
        TRACE(P.bishop_pair, us, 1);
    }
    return score;
}

static Score eval_king(const Position* pos, const EvalInfo* ei, int us) {
    int them = us ^ 1;
    Score score = 0;
    int ksq = king_square(pos, us);
    Bitboard our_pawns = pieces_of(pos, us, PAWN);
    Bitboard occ = pos->occupied;

    // Pawn shield on the king file and its neighbours
    Bitboard files = FILE_BB[file_of(ksq)] | ADJACENT_FILES_BB[file_of(ksq)];
    int r = rank_of(ksq);
    int dir = us == WHITE ? 1 : -1;
    for (int i = 0; i < 2; ++i) {
        int rr = r + dir * (i + 1);
        if (rr < 0 || rr > 7) break;
        int n = popcount(files & RANK_BB[rr] & our_pawns);
        if (n) { score += P.king_shield[i] * n; TRACE(P.king_shield[i], us, n); }
    }
    for (int f = file_of(ksq) - 1; f <= file_of(ksq) + 1; ++f) {
        if (f < 0 || f > 7) continue;
        if (!(FILE_BB[f] & our_pawns)) { score += P.king_open_file; TRACE(P.king_open_file, us, 1); }
    }

    // Safe checks by the opponent (squares not defended by us), counted against us.
    Bitboard safe = ~pos->by_color[them] & ~ei->attacked[us][ALL_PIECES];
    Bitboard knight_checks = KNIGHT_ATTACKS[ksq] & ei->attacked[them][KNIGHT] & safe;
    Bitboard bishop_rays = bishop_attacks(ksq, occ), rook_rays = rook_attacks(ksq, occ);
    Bitboard bishop_checks = bishop_rays & ei->attacked[them][BISHOP] & safe;
    Bitboard rook_checks = rook_rays & ei->attacked[them][ROOK] & safe;
    Bitboard queen_checks = (bishop_rays | rook_rays) & ei->attacked[them][QUEEN] & safe;
    int n;
    if ((n = popcount(knight_checks))) { score -= P.safe_check[KNIGHT] * n; TRACE(P.safe_check[KNIGHT], them, n); }
    if ((n = popcount(bishop_checks))) { score -= P.safe_check[BISHOP] * n; TRACE(P.safe_check[BISHOP], them, n); }
    if ((n = popcount(rook_checks))) { score -= P.safe_check[ROOK] * n; TRACE(P.safe_check[ROOK], them, n); }
    if ((n = popcount(queen_checks))) { score -= P.safe_check[QUEEN] * n; TRACE(P.safe_check[QUEEN], them, n); }
    return score;
}

static Score eval_passed(const Position* pos, const EvalInfo* ei, int us, Bitboard passed) {
    int them = us ^ 1;
    Score score = 0;
    (void)ei;
    while (passed) {
        int sq = pop_lsb(&passed);
        int r = relative_rank(us, sq);
        int front = sq + (us == WHITE ? 8 : -8);
        if (front < 0 || front > 63) continue;
        int d_us = DISTANCE[king_square(pos, us)][front];
        int d_them = DISTANCE[king_square(pos, them)][front];
        score += P.passed_king_dist_us[r] * d_us;
        TRACE(P.passed_king_dist_us[r], us, d_us);
        score += P.passed_king_dist_them[r] * d_them;
        TRACE(P.passed_king_dist_them[r], us, d_them);
        if (pos->occupied & BB(front)) {
            score += P.passed_blocked[r];
            TRACE(P.passed_blocked[r], us, 1);
        }
    }
    return score;
}

static Score eval_threats(const Position* pos, const EvalInfo* ei, int us) {
    int them = us ^ 1;
    Score score = 0;
    for (int pt = KNIGHT; pt <= QUEEN; ++pt) {
        Bitboard victims = pieces_of(pos, them, pt);
        int n;
        if ((n = popcount(victims & ei->attacked[us][PAWN]))) {
            score += P.threat_by_pawn[pt] * n;
            TRACE(P.threat_by_pawn[pt], us, n);
        }
        if ((n = popcount(victims & (ei->attacked[us][KNIGHT] | ei->attacked[us][BISHOP])))) {
            score += P.threat_by_minor[pt] * n;
            TRACE(P.threat_by_minor[pt], us, n);
        }
        if ((n = popcount(victims & ei->attacked[us][ROOK]))) {
            score += P.threat_by_rook[pt] * n;
            TRACE(P.threat_by_rook[pt], us, n);
        }
    }
    // Hanging: enemy pieces we attack that nothing defends.
    Bitboard enemies = pos->by_color[them] & ~pieces_of(pos, them, KING);
    int n = popcount(enemies & ei->attacked[us][ALL_PIECES] & ~ei->attacked[them][ALL_PIECES]);
    if (n) {
        score += P.hanging * n;
        TRACE(P.hanging, us, n);
    }
    return score;
}

// Endgame scale factor out of 128: pull drawish endgames towards zero.
static int scale_factor(const Position* pos, int eg) {
    int strong = eg > 0 ? WHITE : BLACK, weak = strong ^ 1;
    Bitboard strong_pawns = pieces_of(pos, strong, PAWN);
    int npm_strong = 0, npm_weak = 0;
    for (int pt = KNIGHT; pt <= QUEEN; ++pt) {
        npm_strong += popcount(pieces_of(pos, strong, pt)) * SEE_VALUE[pt];
        npm_weak += popcount(pieces_of(pos, weak, pt)) * SEE_VALUE[pt];
    }
    // No pawns and at most a minor piece ahead: very hard to win.
    if (!strong_pawns && npm_strong - npm_weak <= SEE_VALUE[BISHOP]) return npm_strong < SEE_VALUE[ROOK] ? 0 : 16;
    // Opposite-colored bishops with no other pieces.
    Bitboard wb = pieces_of(pos, WHITE, BISHOP), bb = pieces_of(pos, BLACK, BISHOP);
    if (npm_strong == SEE_VALUE[BISHOP] && npm_weak == SEE_VALUE[BISHOP] && wb && bb) {
        const Bitboard dark = 0xAA55AA55AA55AA55ULL;
        if (!!(wb & dark) != !!(bb & dark)) return 64;
    }
    return 128;
}

int evaluate(const Position* pos) {
#ifndef TUNE
    // The accumulators are a cache inside the position, hence the cast.
    if (g_use_nnue) return nnue_evaluate((Position*)pos);
#endif
    EvalInfo ei;
    memset(&ei, 0, sizeof(ei));
    Score score;

#ifdef TUNE
    memset(&T, 0, sizeof(T));
    score = 0;
    for (int sq = 0; sq < 64; ++sq) {
        int pc = pos->board[sq];
        if (pc == NO_PIECE) continue;
        int c = piece_color(pc), pt = piece_type(pc);
        int rsq = c == WHITE ? sq : sq ^ 56;
        Score s = P.material[pt] + P.psqt[pt][rsq];
        score += c == WHITE ? s : -s;
        TRACE(P.material[pt], c, 1);
        TRACE(P.psqt[pt][rsq], c, 1);
    }
#else
    score = S(pos->st->psq_mg, pos->st->psq_eg);
#endif

    for (int c = WHITE; c <= BLACK; ++c) {
        int ksq = king_square(pos, c);
        Bitboard pawns = pieces_of(pos, c, PAWN);
        ei.attacked[c][PAWN] = pawn_attacks_bb(c, pawns);
        ei.attacked[c][KING] = KING_ATTACKS[ksq];
        ei.attacked[c][ALL_PIECES] = ei.attacked[c][PAWN] | ei.attacked[c][KING];
        ei.attacked2[c] = ei.attacked[c][PAWN] & ei.attacked[c][KING];
        ei.king_zone[c] = KING_ATTACKS[ksq] | BB(ksq);
    }
    for (int c = WHITE; c <= BLACK; ++c)
        ei.mobility_area[c] = ~(pieces_of(pos, c, PAWN) | pieces_of(pos, c, KING)) & ~ei.attacked[c ^ 1][PAWN];

    Bitboard passed[2];
    score += pawn_structure(pos, passed);
    score += eval_pieces(pos, &ei, WHITE) - eval_pieces(pos, &ei, BLACK);
    score += eval_king(pos, &ei, WHITE) - eval_king(pos, &ei, BLACK);
    score += eval_passed(pos, &ei, WHITE, passed[WHITE]) - eval_passed(pos, &ei, BLACK, passed[BLACK]);
    score += eval_threats(pos, &ei, WHITE) - eval_threats(pos, &ei, BLACK);
    score += pos->side == WHITE ? P.tempo : -P.tempo;
    TRACE(P.tempo, pos->side, 1);

    int phase = pos->st->phase > 24 ? 24 : pos->st->phase;
    int mg = mg_value(score), eg = eg_value(score);
    int scale = scale_factor(pos, eg);
#ifdef TUNE
    T.phase = phase;
    T.scale = scale;
#endif
    int v = (mg * phase + eg * (24 - phase) * scale / 128) / 24;
    return pos->side == WHITE ? v : -v;
}

// ---------------------------------------------------------------------------
// Parameter printing (tuner output, pasted back into the P initializer)
// ---------------------------------------------------------------------------

static void print_score(Score s) { printf("S(%d, %d)", mg_value(s), eg_value(s)); }

static void print_array(const char* name, const Score* a, int n, int per_line) {
    printf("    .%s = {", name);
    for (int i = 0; i < n; ++i) {
        if (per_line && i % per_line == 0) printf("\n        ");
        print_score(a[i]);
        if (i + 1 < n) printf(", ");
    }
    printf(per_line ? "\n    },\n" : "},\n");
}

static void print_single(const char* name, Score s) {
    printf("    .%s = ", name);
    print_score(s);
    printf(",\n");
}

void eval_print_params(void) {
    printf("EvalParams P = {\n");
    print_array("material", P.material, 6, 0);
    printf("    .psqt = {\n");
    for (int pt = 0; pt < 6; ++pt) {
        printf("        {");
        for (int sq = 0; sq < 64; ++sq) {
            if (sq % 8 == 0) printf("\n            ");
            print_score(P.psqt[pt][sq]);
            if (sq < 63) printf(", ");
        }
        printf("\n        },\n");
    }
    printf("    },\n");
    print_single("bishop_pair", P.bishop_pair);
    print_single("doubled_pawn", P.doubled_pawn);
    print_single("isolated_pawn", P.isolated_pawn);
    print_single("backward_pawn", P.backward_pawn);
    print_array("passed_pawn", P.passed_pawn, 8, 0);
    print_array("passed_king_dist_us", P.passed_king_dist_us, 8, 0);
    print_array("passed_king_dist_them", P.passed_king_dist_them, 8, 0);
    print_array("passed_blocked", P.passed_blocked, 8, 0);
    print_array("connected_pawn", P.connected_pawn, 8, 0);
    print_array("knight_mobility", P.knight_mobility, 9, 5);
    print_array("bishop_mobility", P.bishop_mobility, 14, 5);
    print_array("rook_mobility", P.rook_mobility, 15, 5);
    print_array("queen_mobility", P.queen_mobility, 28, 5);
    print_single("rook_open_file", P.rook_open_file);
    print_single("rook_semi_open_file", P.rook_semi_open_file);
    print_single("knight_outpost", P.knight_outpost);
    print_single("bishop_outpost", P.bishop_outpost);
    print_array("king_zone_attack", P.king_zone_attack, 6, 0);
    print_array("safe_check", P.safe_check, 6, 0);
    print_array("king_shield", P.king_shield, 2, 0);
    print_single("king_open_file", P.king_open_file);
    print_array("threat_by_pawn", P.threat_by_pawn, 6, 0);
    print_array("threat_by_minor", P.threat_by_minor, 6, 0);
    print_array("threat_by_rook", P.threat_by_rook, 6, 0);
    print_single("hanging", P.hanging);
    print_single("tempo", P.tempo);
    printf("};\n");
    fflush(stdout);
}
