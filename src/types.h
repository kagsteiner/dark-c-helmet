#ifndef TYPES_H
#define TYPES_H

#include <stdint.h>
#include <stddef.h>

#define ENGINE_NAME "Dark C. Helmet 2"
#define ENGINE_VERSION "dev"
#define ENGINE_AUTHOR "Karlheinz Agsteiner + Claude"

typedef uint64_t Bitboard;
typedef uint16_t Move;

enum { WHITE, BLACK };
enum { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING };

// Piece = color * 6 + type; NO_PIECE marks an empty square.
enum {
    W_PAWN, W_KNIGHT, W_BISHOP, W_ROOK, W_QUEEN, W_KING,
    B_PAWN, B_KNIGHT, B_BISHOP, B_ROOK, B_QUEEN, B_KING,
    NO_PIECE
};

enum {
    A1, B1, C1, D1, E1, F1, G1, H1,
    A2, B2, C2, D2, E2, F2, G2, H2,
    A3, B3, C3, D3, E3, F3, G3, H3,
    A4, B4, C4, D4, E4, F4, G4, H4,
    A5, B5, C5, D5, E5, F5, G5, H5,
    A6, B6, C6, D6, E6, F6, G6, H6,
    A7, B7, C7, D7, E7, F7, G7, H7,
    A8, B8, C8, D8, E8, F8, G8, H8,
    NO_SQ = 64
};

enum { WHITE_OO = 1, WHITE_OOO = 2, BLACK_OO = 4, BLACK_OOO = 8 };

// Move layout: bits 0-5 from, 6-11 to, 12-15 flags (CPW "from-to-flags" encoding).
enum {
    FLAG_QUIET = 0,
    FLAG_DOUBLE_PUSH = 1,
    FLAG_KING_CASTLE = 2,
    FLAG_QUEEN_CASTLE = 3,
    FLAG_CAPTURE = 4,
    FLAG_EP = 5,
    FLAG_PROMO = 8,            // + (promo type - KNIGHT); | FLAG_CAPTURE for promo-captures
};

#define MOVE_NONE ((Move)0)

static inline Move make_move(int from, int to, int flags) { return (Move)(from | (to << 6) | (flags << 12)); }
static inline int move_from(Move m) { return m & 63; }
static inline int move_to(Move m) { return (m >> 6) & 63; }
static inline int move_flags(Move m) { return m >> 12; }
static inline int move_is_capture(Move m) { return (m >> 12) & FLAG_CAPTURE; }
static inline int move_is_promo(Move m) { return (m >> 12) & FLAG_PROMO; }
static inline int move_promo_type(Move m) { return ((m >> 12) & 3) + KNIGHT; }
static inline int move_is_castle(Move m) { int f = m >> 12; return f == FLAG_KING_CASTLE || f == FLAG_QUEEN_CASTLE; }
static inline int move_is_tactical(Move m) { return (m >> 12) & (FLAG_CAPTURE | FLAG_PROMO); }

static inline int make_piece(int color, int type) { return color * 6 + type; }
static inline int piece_type(int pc) { return pc % 6; }
static inline int piece_color(int pc) { return pc / 6; }

static inline int rank_of(int sq) { return sq >> 3; }
static inline int file_of(int sq) { return sq & 7; }
static inline int make_square(int rank, int file) { return rank * 8 + file; }
static inline int relative_rank(int color, int sq) { return color == WHITE ? rank_of(sq) : 7 - rank_of(sq); }
static inline int relative_square(int color, int sq) { return color == WHITE ? sq : sq ^ 56; }

#define MAX_MOVES 256
#define MAX_PLY 128
#define MAX_GAME_PLY 1024

#define VALUE_INF 32000
#define VALUE_MATE 31000
#define VALUE_MATE_IN_MAX (VALUE_MATE - MAX_PLY)
#define VALUE_NONE 32001
#define VALUE_DRAW 0

typedef struct {
    Move move;
    int score;
} ScoredMove;

typedef struct {
    ScoredMove moves[MAX_MOVES];
    int count;
} MoveList;

#endif
