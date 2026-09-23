#include "eval.h"

#include <stdio.h>
#include <string.h>

// Hand-crafted tapered evaluation. Every weight lives in P (see eval.h) so that it can be
// fitted with the Texel tuner (tools/tune). Starting values for material and piece-square
// tables are PeSTO's (Ronald Friederich); they are loaded once and replaced by tuned values.

// PeSTO tables, White's view with a8 first, as published.
static const int PESTO_MG_VALUE[6] = {82, 337, 365, 477, 1025, 0};
static const int PESTO_EG_VALUE[6] = {94, 281, 297, 512, 936, 0};

static const int MG_PAWN[64] = {
      0,   0,   0,   0,   0,   0,   0,   0,
     98, 134,  61,  95,  68, 126,  34, -11,
     -6,   7,  26,  31,  65,  56,  25, -20,
    -14,  13,   6,  21,  23,  12,  17, -23,
    -27,  -2,  -5,  12,  17,   6,  10, -25,
    -26,  -4,  -4, -10,   3,   3,  33, -12,
    -35,  -1, -20, -23, -15,  24,  38, -22,
      0,   0,   0,   0,   0,   0,   0,   0,
};
static const int EG_PAWN[64] = {
      0,   0,   0,   0,   0,   0,   0,   0,
    178, 173, 158, 134, 147, 132, 165, 187,
     94, 100,  85,  67,  56,  53,  82,  84,
     32,  24,  13,   5,  -2,   4,  17,  17,
     13,   9,  -3,  -7,  -7,  -8,   3,  -1,
      4,   7,  -6,   1,   0,  -5,  -1,  -8,
     13,   8,   8,  10,  13,   0,   2,  -7,
      0,   0,   0,   0,   0,   0,   0,   0,
};
static const int MG_KNIGHT[64] = {
    -167, -89, -34, -49,  61, -97, -15, -107,
     -73, -41,  72,  36,  23,  62,   7,  -17,
     -47,  60,  37,  65,  84, 129,  73,   44,
      -9,  17,  19,  53,  37,  69,  18,   22,
     -13,   4,  16,  13,  28,  19,  21,   -8,
     -23,  -9,  12,  10,  19,  17,  25,  -16,
     -29, -53, -12,  -3,  -1,  18, -14,  -19,
    -105, -21, -58, -33, -17, -28, -19,  -23,
};
static const int EG_KNIGHT[64] = {
    -58, -38, -13, -28, -31, -27, -63, -99,
    -25,  -8, -25,  -2,  -9, -25, -24, -52,
    -24, -20,  10,   9,  -1,  -9, -19, -41,
    -17,   3,  22,  22,  22,  11,   8, -18,
    -18,  -6,  16,  25,  16,  17,   4, -18,
    -23,  -3,  -1,  15,  10,  -3, -20, -22,
    -42, -20, -10,  -5,  -2, -20, -23, -44,
    -29, -51, -23, -15, -22, -18, -50, -64,
};
static const int MG_BISHOP[64] = {
    -29,   4, -82, -37, -25, -42,   7,  -8,
    -26,  16, -18, -13,  30,  59,  18, -47,
    -16,  37,  43,  40,  35,  50,  37,  -2,
     -4,   5,  19,  50,  37,  37,   7,  -2,
     -6,  13,  13,  26,  34,  12,  10,   4,
      0,  15,  15,  15,  14,  27,  18,  10,
      4,  15,  16,   0,   7,  21,  33,   1,
    -33,  -3, -14, -21, -13, -12, -39, -21,
};
static const int EG_BISHOP[64] = {
    -14, -21, -11,  -8,  -7,  -9, -17, -24,
     -8,  -4,   7, -12,  -3, -13,  -4, -14,
      2,  -8,   0,  -1,  -2,   6,   0,   4,
     -3,   9,  12,   9,  14,  10,   3,   2,
     -6,   3,  13,  19,   7,  10,  -3,  -9,
    -12,  -3,   8,  10,  13,   3,  -7, -15,
    -14, -18,  -7,  -1,   4,  -9, -15, -27,
    -23,  -9, -23,  -5,  -9, -16,  -5, -17,
};
static const int MG_ROOK[64] = {
     32,  42,  32,  51,  63,   9,  31,  43,
     27,  32,  58,  62,  80,  67,  26,  44,
     -5,  19,  26,  36,  17,  45,  61,  16,
    -24, -11,   7,  26,  24,  35,  -8, -20,
    -36, -26, -12,  -1,   9,  -7,   6, -23,
    -45, -25, -16, -17,   3,   0,  -5, -33,
    -44, -16, -20,  -9,  -1,  11,  -6, -71,
    -19, -13,   1,  17,  16,   7, -37, -26,
};
static const int EG_ROOK[64] = {
     13,  10,  18,  15,  12,  12,   8,   5,
     11,  13,  13,  11,  -3,   3,   8,   3,
      7,   7,   7,   5,   4,  -3,  -5,  -3,
      4,   3,  13,   1,   2,   1,  -1,   2,
      3,   5,   8,   4,  -5,  -6,  -8, -11,
     -4,   0,  -5,  -1,  -7, -12,  -8, -16,
     -6,  -6,   0,   2,  -9,  -9, -11,  -3,
     -9,   2,   3,  -1,  -5, -13,   4, -20,
};
static const int MG_QUEEN[64] = {
    -28,   0,  29,  12,  59,  44,  43,  45,
    -24, -39,  -5,   1, -16,  57,  28,  54,
    -13, -17,   7,   8,  29,  56,  47,  57,
    -27, -27, -16, -16,  -1,  17,  -2,   1,
     -9, -26,  -9, -10,  -2,  -4,   3,  -3,
    -14,   2, -11,  -2,  -5,   2,  14,   5,
    -35,  -8,  11,   2,   8,  15,  -3,   1,
     -1, -18,  -9,  10, -15, -25, -31, -50,
};
static const int EG_QUEEN[64] = {
     -9,  22,  22,  27,  27,  19,  10,  20,
    -17,  20,  32,  41,  58,  25,  30,   0,
    -20,   6,   9,  49,  47,  35,  19,   9,
      3,  22,  24,  45,  57,  40,  57,  36,
    -18,  28,  19,  47,  31,  34,  39,  23,
    -16, -27,  15,   6,   9,  17,  10,   5,
    -22, -23, -30, -16, -16, -23, -36, -32,
    -33, -28, -22, -43,  -5, -32, -20, -41,
};
static const int MG_KING[64] = {
    -65,  23,  16, -15, -56, -34,   2,  13,
     29,  -1, -20,  -7,  -8,  -4, -38, -29,
     -9,  24,   2, -16, -20,   6,  22, -22,
    -17, -20, -12, -27, -30, -25, -14, -36,
    -49,  -1, -27, -39, -46, -44, -33, -51,
    -14, -14, -22, -46, -44, -30, -15, -27,
      1,   7,  -8, -64, -43, -16,   9,   8,
    -15,  36,  12, -54,   8, -28,  24,  14,
};
static const int EG_KING[64] = {
    -74, -35, -18, -18, -11,  15,   4, -17,
    -12,  17,  14,  17,  17,  38,  23,  11,
     10,  17,  23,  15,  20,  45,  44,  13,
     -8,  22,  24,  27,  26,  33,  26,   3,
    -18,  -4,  21,  24,  27,  23,   9, -11,
    -19,  -3,  11,  21,  23,  16,   7,  -9,
    -27, -11,   4,  13,  14,   4,  -5, -17,
    -53, -34, -21, -11, -28, -14, -24, -43,
};

static const int* const PESTO_MG[6] = {MG_PAWN, MG_KNIGHT, MG_BISHOP, MG_ROOK, MG_QUEEN, MG_KING};
static const int* const PESTO_EG[6] = {EG_PAWN, EG_KNIGHT, EG_BISHOP, EG_ROOK, EG_QUEEN, EG_KING};


#define ALL_PIECES 6  // index into attacked[] for "attacked by any piece"

EvalParams P = {
    .material = {0},  // filled from PeSTO in eval_init until tuned values are pasted here
    .bishop_pair = S(30, 50),
    .doubled_pawn = S(-10, -20),
    .isolated_pawn = S(-5, -12),
    .backward_pawn = S(-5, -8),
    .passed_pawn = {0, S(-5, 10), S(-5, 15), S(0, 25), S(20, 50), S(40, 90), S(70, 140), 0},
    .passed_king_dist_us = {0},
    .passed_king_dist_them = {0},
    .passed_blocked = {0},
    .connected_pawn = {0, S(3, 0), S(5, 3), S(8, 5), S(12, 10), S(20, 20), S(30, 30), 0},
    .knight_mobility = {S(-16,-16), S(-12,-12), S(-8,-8), S(-4,-4), S(0,0), S(4,4), S(8,8), S(12,12), S(16,16)},
    .bishop_mobility = {S(-24,-30), S(-20,-25), S(-16,-20), S(-12,-15), S(-8,-10), S(-4,-5), S(0,0),
                        S(4,5), S(8,10), S(12,15), S(16,20), S(20,25), S(24,30), S(28,35)},
    .rook_mobility = {S(-14,-28), S(-12,-24), S(-10,-20), S(-8,-16), S(-6,-12), S(-4,-8), S(-2,-4), S(0,0),
                      S(2,4), S(4,8), S(6,12), S(8,16), S(10,20), S(12,24), S(14,28)},
    .queen_mobility = {S(-13,-26), S(-12,-24), S(-11,-22), S(-10,-20), S(-9,-18), S(-8,-16), S(-7,-14),
                       S(-6,-12), S(-5,-10), S(-4,-8), S(-3,-6), S(-2,-4), S(-1,-2), S(0,0), S(1,2), S(2,4),
                       S(3,6), S(4,8), S(5,10), S(6,12), S(7,14), S(8,16), S(9,18), S(10,20), S(11,22),
                       S(12,24), S(13,26), S(14,28)},
    .rook_open_file = S(25, 10),
    .rook_semi_open_file = S(10, 5),
    .knight_outpost = S(20, 10),
    .bishop_outpost = S(15, 5),
    .king_zone_attack = {0, S(8, 0), S(6, 0), S(8, 0), S(12, 0), 0},
    .safe_check = {0, S(30, 0), S(20, 0), S(40, 0), S(30, 0), 0},
    .king_shield = {S(10, 0), S(5, 0)},
    .king_open_file = S(-15, 0),
    .threat_by_pawn = {0, S(40, 20), S(40, 20), S(50, 20), S(50, 20), 0},
    .threat_by_minor = {0, S(10, 10), S(10, 10), S(30, 20), S(30, 20), 0},
    .threat_by_rook = {0, 0, 0, 0, S(30, 10), 0},
    .hanging = S(20, 10),
    .tempo = S(15, 15),
};

static int params_from_pesto = 1;

int PSQ_MG[12][64];
int PSQ_EG[12][64];

#ifdef TUNE
EvalTrace T;
#define TRACE(field, color, n) (T.coeff[(Score*)&(field) - (Score*)&P][color] += (n))
#else
#define TRACE(field, color, n) ((void)0)
#endif

void eval_init(void) {
    if (params_from_pesto) {
        params_from_pesto = 0;
        for (int pt = PAWN; pt <= KING; ++pt) {
            P.material[pt] = S(PESTO_MG_VALUE[pt], PESTO_EG_VALUE[pt]);
            for (int sq = 0; sq < 64; ++sq) P.psqt[pt][sq] = S(PESTO_MG[pt][sq ^ 56], PESTO_EG[pt][sq ^ 56]);
        }
    }
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
