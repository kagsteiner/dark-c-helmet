#ifndef POSITION_H
#define POSITION_H

#include "bitboard.h"

#define NNUE_HIDDEN 256

// Pieces changed by the move that led to a state (for incremental NNUE updates).
// from == NO_SQ means the piece appeared, to == NO_SQ means it disappeared.
typedef struct {
    int count;
    int piece[3];
    int from[3];
    int to[3];
} DirtyPieces;

// NNUE first-layer output for both perspectives, one per state.
typedef struct {
    int16_t values[2][NNUE_HIDDEN];
    int computed;
} Accumulator;

// Per-ply state. make_move pushes a copy and modifies it; unmake pops it.
typedef struct {
    uint64_t key;
    uint64_t pawn_key;
    int castling;
    int ep_sq;           // NO_SQ if none; only set when an en-passant capture is actually possible
    int rule50;
    int plies_from_null;
    int captured;        // piece captured by the move that led here
    Move move;           // move that led here
    Bitboard checkers;   // enemy pieces giving check to the side to move
    Bitboard pinned;     // own pieces pinned to own king (side to move)
    int psq_mg, psq_eg;  // material + piece-square score, white's point of view
    int phase;           // 0 (pawn endgame) .. 24 (all pieces)
    DirtyPieces dirty;
} State;

typedef struct {
    Bitboard pieces[12];
    Bitboard by_color[2];
    Bitboard occupied;
    uint8_t board[64];
    int side;
    int fullmove_base;   // fullmove number in the FEN
    int start_side;      // side to move in the FEN
    int game_ply;        // plies since the FEN
    State states[MAX_GAME_PLY + MAX_PLY + 8];
    State* st;
    Accumulator acc[MAX_GAME_PLY + MAX_PLY + 8];  // acc[i] belongs to states[i]
} Position;

extern uint64_t ZOBRIST_PIECE[12][64];
extern uint64_t ZOBRIST_CASTLING[16];
extern uint64_t ZOBRIST_EP[8];
extern uint64_t ZOBRIST_SIDE;

// Values used by SEE and move ordering (independent of the tuned eval).
extern const int SEE_VALUE[6];
// Phase weight per piece type (N=1, B=1, R=2, Q=4).
extern const int PHASE_WEIGHT[6];
// Material + PST tables, filled by eval_init(), consumed incrementally by make/unmake.
extern int PSQ_MG[12][64];
extern int PSQ_EG[12][64];

#define START_FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

void position_init(void);
int pos_set_fen(Position* pos, const char* fen);
void pos_to_fen(const Position* pos, char* out, size_t size);
void pos_print(const Position* pos);

void pos_make_move(Position* pos, Move m);
void pos_unmake_move(Position* pos, Move m);
void pos_make_null(Position* pos);
void pos_unmake_null(Position* pos);

int pos_is_legal(const Position* pos, Move m);
int pos_is_repetition(const Position* pos, int ply_from_root);
int pos_is_draw(const Position* pos, int ply_from_root);
int see_ge(const Position* pos, Move m, int threshold);

Move pos_parse_move(Position* pos, const char* str);  // UCI string -> legal move, or MOVE_NONE
void move_to_str(Move m, char out[6]);

static inline Bitboard pieces_of(const Position* pos, int color, int type) {
    return pos->pieces[make_piece(color, type)];
}
static inline Bitboard pieces_type(const Position* pos, int type) {
    return pos->pieces[type] | pos->pieces[type + 6];
}
static inline int king_square(const Position* pos, int color) {
    return lsb(pos->pieces[make_piece(color, KING)]);
}
static inline int in_check(const Position* pos) { return pos->st->checkers != 0; }
static inline int piece_on(const Position* pos, int sq) { return pos->board[sq]; }
static inline int moved_piece(const Position* pos, Move m) { return pos->board[move_from(m)]; }

static inline Bitboard attackers_to(const Position* pos, int sq, Bitboard occ) {
    return (PAWN_ATTACKS[BLACK][sq] & pos->pieces[W_PAWN]) |
           (PAWN_ATTACKS[WHITE][sq] & pos->pieces[B_PAWN]) |
           (KNIGHT_ATTACKS[sq] & (pos->pieces[W_KNIGHT] | pos->pieces[B_KNIGHT])) |
           (bishop_attacks(sq, occ) & (pieces_type(pos, BISHOP) | pieces_type(pos, QUEEN))) |
           (rook_attacks(sq, occ) & (pieces_type(pos, ROOK) | pieces_type(pos, QUEEN))) |
           (KING_ATTACKS[sq] & (pos->pieces[W_KING] | pos->pieces[B_KING]));
}

static inline int square_attacked(const Position* pos, int sq, int by, Bitboard occ) {
    return (PAWN_ATTACKS[by ^ 1][sq] & pieces_of(pos, by, PAWN)) ||
           (KNIGHT_ATTACKS[sq] & pieces_of(pos, by, KNIGHT)) ||
           (KING_ATTACKS[sq] & pieces_of(pos, by, KING)) ||
           (bishop_attacks(sq, occ) & (pieces_of(pos, by, BISHOP) | pieces_of(pos, by, QUEEN))) ||
           (rook_attacks(sq, occ) & (pieces_of(pos, by, ROOK) | pieces_of(pos, by, QUEEN)));
}

static inline int non_pawn_material(const Position* pos, int color) {
    return (pieces_of(pos, color, KNIGHT) | pieces_of(pos, color, BISHOP) |
            pieces_of(pos, color, ROOK) | pieces_of(pos, color, QUEEN)) != 0;
}

#endif
