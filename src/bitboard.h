#ifndef BITBOARD_H
#define BITBOARD_H

#include "types.h"

#if defined(_MSC_VER)
#include <intrin.h>
static inline int lsb(Bitboard b) { unsigned long i; _BitScanForward64(&i, b); return (int)i; }
static inline int msb(Bitboard b) { unsigned long i; _BitScanReverse64(&i, b); return (int)i; }
#if defined(_M_X64) || defined(_M_AMD64)
static inline int popcount(Bitboard b) { return (int)__popcnt64(b); }
#else
static inline int popcount(Bitboard b) {
    b = b - ((b >> 1) & 0x5555555555555555ULL);
    b = (b & 0x3333333333333333ULL) + ((b >> 2) & 0x3333333333333333ULL);
    b = (b + (b >> 4)) & 0x0F0F0F0F0F0F0F0FULL;
    return (int)((b * 0x0101010101010101ULL) >> 56);
}
#endif
#else
static inline int lsb(Bitboard b) { return __builtin_ctzll(b); }
static inline int msb(Bitboard b) { return 63 - __builtin_clzll(b); }
static inline int popcount(Bitboard b) { return __builtin_popcountll(b); }
#endif

static inline int pop_lsb(Bitboard* b) {
    int sq = lsb(*b);
    *b &= *b - 1;
    return sq;
}

#define BB(sq) (1ULL << (sq))
static inline int more_than_one(Bitboard b) { return (b & (b - 1)) != 0; }

#define FILE_A_BB 0x0101010101010101ULL
#define FILE_H_BB (FILE_A_BB << 7)
#define RANK_1_BB 0xFFULL
#define RANK_8_BB (RANK_1_BB << 56)

extern Bitboard FILE_BB[8];
extern Bitboard RANK_BB[8];
extern Bitboard PAWN_ATTACKS[2][64];
extern Bitboard KNIGHT_ATTACKS[64];
extern Bitboard KING_ATTACKS[64];
extern Bitboard BETWEEN_BB[64][64];   // squares strictly between two aligned squares
extern Bitboard LINE_BB[64][64];      // full line through two aligned squares (0 if not aligned)
extern Bitboard ADJACENT_FILES_BB[8];
extern Bitboard PASSED_MASK[2][64];   // squares in front on same + adjacent files
extern Bitboard FORWARD_FILE_BB[2][64];
extern int DISTANCE[64][64];

typedef struct {
    Bitboard mask;
    Bitboard magic;
    Bitboard* attacks;
    int shift;
} Magic;

extern Magic ROOK_MAGICS[64];
extern Magic BISHOP_MAGICS[64];

void bitboards_init(void);

static inline Bitboard bishop_attacks(int sq, Bitboard occ) {
    const Magic* m = &BISHOP_MAGICS[sq];
    return m->attacks[((occ & m->mask) * m->magic) >> m->shift];
}

static inline Bitboard rook_attacks(int sq, Bitboard occ) {
    const Magic* m = &ROOK_MAGICS[sq];
    return m->attacks[((occ & m->mask) * m->magic) >> m->shift];
}

static inline Bitboard queen_attacks(int sq, Bitboard occ) {
    return bishop_attacks(sq, occ) | rook_attacks(sq, occ);
}

static inline Bitboard piece_attacks(int type, int sq, Bitboard occ) {
    switch (type) {
        case KNIGHT: return KNIGHT_ATTACKS[sq];
        case BISHOP: return bishop_attacks(sq, occ);
        case ROOK: return rook_attacks(sq, occ);
        case QUEEN: return queen_attacks(sq, occ);
        case KING: return KING_ATTACKS[sq];
        default: return 0;
    }
}

static inline Bitboard shift_north(Bitboard b) { return b << 8; }
static inline Bitboard shift_south(Bitboard b) { return b >> 8; }
static inline Bitboard pawn_push(int color, Bitboard b) { return color == WHITE ? b << 8 : b >> 8; }
static inline Bitboard pawn_attacks_bb(int color, Bitboard pawns) {
    if (color == WHITE) return ((pawns & ~FILE_A_BB) << 7) | ((pawns & ~FILE_H_BB) << 9);
    return ((pawns & ~FILE_A_BB) >> 9) | ((pawns & ~FILE_H_BB) >> 7);
}

#endif
