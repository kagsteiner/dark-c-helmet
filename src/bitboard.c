#include "bitboard.h"

#include <stdlib.h>
#include <string.h>

Bitboard FILE_BB[8];
Bitboard RANK_BB[8];
Bitboard PAWN_ATTACKS[2][64];
Bitboard KNIGHT_ATTACKS[64];
Bitboard KING_ATTACKS[64];
Bitboard BETWEEN_BB[64][64];
Bitboard LINE_BB[64][64];
Bitboard ADJACENT_FILES_BB[8];
Bitboard PASSED_MASK[2][64];
Bitboard FORWARD_FILE_BB[2][64];
int DISTANCE[64][64];

Magic ROOK_MAGICS[64];
Magic BISHOP_MAGICS[64];

static Bitboard ROOK_TABLE[102400];
static Bitboard BISHOP_TABLE[5248];

static const int ROOK_DIRS[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
static const int BISHOP_DIRS[4][2] = {{1, 1}, {1, -1}, {-1, 1}, {-1, -1}};

// Attacks computed by walking rays; used only to build the magic tables.
static Bitboard sliding_attacks(int sq, Bitboard occ, const int dirs[4][2]) {
    Bitboard attacks = 0;
    int r0 = rank_of(sq), f0 = file_of(sq);
    for (int d = 0; d < 4; ++d) {
        int r = r0 + dirs[d][0], f = f0 + dirs[d][1];
        while (r >= 0 && r < 8 && f >= 0 && f < 8) {
            int s = make_square(r, f);
            attacks |= BB(s);
            if (occ & BB(s)) break;
            r += dirs[d][0];
            f += dirs[d][1];
        }
    }
    return attacks;
}

static uint64_t rng_state = 0x9E3779B97F4A7C15ULL;
static uint64_t rng_next(void) {
    // xorshift64*
    rng_state ^= rng_state >> 12;
    rng_state ^= rng_state << 25;
    rng_state ^= rng_state >> 27;
    return rng_state * 2685821657736338717ULL;
}

static void init_magics(Magic* magics, Bitboard* table, const int dirs[4][2]) {
    static Bitboard occupancy[4096], reference[4096];
    static int epoch[4096];
    int current_epoch = 0;
    Bitboard* next = table;

    for (int sq = 0; sq < 64; ++sq) {
        Magic* m = &magics[sq];
        Bitboard edges = ((RANK_1_BB | RANK_8_BB) & ~RANK_BB[rank_of(sq)]) |
                         ((FILE_A_BB | FILE_H_BB) & ~FILE_BB[file_of(sq)]);
        m->mask = sliding_attacks(sq, 0, dirs) & ~edges;
        m->shift = 64 - popcount(m->mask);
        m->attacks = next;

        // Enumerate all subsets of the mask (Carry-Rippler).
        int size = 0;
        Bitboard b = 0;
        do {
            occupancy[size] = b;
            reference[size] = sliding_attacks(sq, b, dirs);
            size++;
            b = (b - m->mask) & m->mask;
        } while (b);

        for (;;) {
            do {
                m->magic = rng_next() & rng_next() & rng_next();
            } while (popcount((m->mask * m->magic) >> 56) < 6);

            current_epoch++;
            int ok = 1;
            for (int i = 0; i < size; ++i) {
                unsigned idx = (unsigned)(((occupancy[i] & m->mask) * m->magic) >> m->shift);
                if (epoch[idx] < current_epoch) {
                    epoch[idx] = current_epoch;
                    m->attacks[idx] = reference[i];
                } else if (m->attacks[idx] != reference[i]) {
                    ok = 0;
                    break;
                }
            }
            if (ok) break;
        }
        next += (size_t)1 << (64 - m->shift);
    }
}

void bitboards_init(void) {
    for (int i = 0; i < 8; ++i) {
        FILE_BB[i] = FILE_A_BB << i;
        RANK_BB[i] = RANK_1_BB << (8 * i);
    }
    for (int f = 0; f < 8; ++f) {
        ADJACENT_FILES_BB[f] = (f > 0 ? FILE_BB[f - 1] : 0) | (f < 7 ? FILE_BB[f + 1] : 0);
    }

    for (int sq = 0; sq < 64; ++sq) {
        int r = rank_of(sq), f = file_of(sq);
        Bitboard b = BB(sq);
        PAWN_ATTACKS[WHITE][sq] = pawn_attacks_bb(WHITE, b);
        PAWN_ATTACKS[BLACK][sq] = pawn_attacks_bb(BLACK, b);

        static const int kn[8][2] = {{1, 2}, {2, 1}, {2, -1}, {1, -2}, {-1, -2}, {-2, -1}, {-2, 1}, {-1, 2}};
        KNIGHT_ATTACKS[sq] = 0;
        KING_ATTACKS[sq] = 0;
        for (int i = 0; i < 8; ++i) {
            int nr = r + kn[i][0], nf = f + kn[i][1];
            if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) KNIGHT_ATTACKS[sq] |= BB(make_square(nr, nf));
        }
        for (int dr = -1; dr <= 1; ++dr) {
            for (int df = -1; df <= 1; ++df) {
                if (!dr && !df) continue;
                int nr = r + dr, nf = f + df;
                if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) KING_ATTACKS[sq] |= BB(make_square(nr, nf));
            }
        }

        Bitboard fwd_w = 0, fwd_b = 0;
        for (int rr = r + 1; rr < 8; ++rr) fwd_w |= RANK_BB[rr];
        for (int rr = r - 1; rr >= 0; --rr) fwd_b |= RANK_BB[rr];
        FORWARD_FILE_BB[WHITE][sq] = fwd_w & FILE_BB[f];
        FORWARD_FILE_BB[BLACK][sq] = fwd_b & FILE_BB[f];
        PASSED_MASK[WHITE][sq] = fwd_w & (FILE_BB[f] | ADJACENT_FILES_BB[f]);
        PASSED_MASK[BLACK][sq] = fwd_b & (FILE_BB[f] | ADJACENT_FILES_BB[f]);
    }

    init_magics(ROOK_MAGICS, ROOK_TABLE, ROOK_DIRS);
    init_magics(BISHOP_MAGICS, BISHOP_TABLE, BISHOP_DIRS);

    for (int a = 0; a < 64; ++a) {
        for (int b = 0; b < 64; ++b) {
            int dr = abs(rank_of(a) - rank_of(b)), df = abs(file_of(a) - file_of(b));
            DISTANCE[a][b] = dr > df ? dr : df;
            BETWEEN_BB[a][b] = 0;
            LINE_BB[a][b] = 0;
            if (a == b) continue;
            if (bishop_attacks(a, 0) & BB(b)) {
                BETWEEN_BB[a][b] = bishop_attacks(a, BB(b)) & bishop_attacks(b, BB(a));
                LINE_BB[a][b] = (bishop_attacks(a, 0) & bishop_attacks(b, 0)) | BB(a) | BB(b);
            } else if (rook_attacks(a, 0) & BB(b)) {
                BETWEEN_BB[a][b] = rook_attacks(a, BB(b)) & rook_attacks(b, BB(a));
                LINE_BB[a][b] = (rook_attacks(a, 0) & rook_attacks(b, 0)) | BB(a) | BB(b);
            }
        }
    }
}
