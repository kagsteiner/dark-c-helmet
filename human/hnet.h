// Human-like player: the network shared by the converter, the trainer and the engine.
//
// Everything is seen from the side to move: when Black is to move the board is mirrored
// (a1 <-> a8) and the colours are swapped, so the mover always plays "up the board".
//
// Input:  12 x 64 piece-square features (own P N B R Q K, then the opponent's) + 4 castling
//         rights (own O-O, own O-O-O, opponent O-O, opponent O-O-O).
// Hidden: HNET_H1 -> HNET_H2, ReLU.
// Policy: one logit per from-to pair (64 x 64, mirrored squares); a promotion is its pawn
//         move (the engine always promotes to a queen). Castling is e1 -> g1/c1 (also in Chess960).
// Value:  probability that the side to move wins (draw = half), as players of the band
//         that the training games come from would score from here.
#ifndef HNET_H
#define HNET_H

#include <stdint.h>

#include "position.h"

#define HNET_INPUTS (12 * 64 + 4)
#define HNET_H1 512
#define HNET_H2 256
#define HNET_MOVES 4096

// One training position, 72 bytes. board[]: 0-5 own pieces, 6-11 opponent's, 12 empty.
typedef struct {
    uint8_t board[64];
    uint8_t castling;  // bits: own O-O, own O-O-O, opponent O-O, opponent O-O-O
    uint8_t elo;       // average rating of both players / 10, capped at 255
    uint16_t move;     // policy index of the move played
    int8_t result;     // +1 the mover won, 0 draw, -1 lost
    uint8_t ply;       // half-moves since the start, capped at 255
    uint8_t pad[2];
} HSample;

// Network weights as floats. File layout (trainer output, "HNET1" + sizes, then the arrays
// in this order): w1[HNET_INPUTS][HNET_H1], b1, w2[HNET_H1][HNET_H2], b2,
// w3[HNET_MOVES][HNET_H2] (one row per move), b3, w4[HNET_H2], b4.
typedef struct {
    float* w1;
    float* b1;
    float* w2;
    float* b2;
    float* w3;
    float* b3;
    float* w4;
    float* b4;
} HNet;

#define HNET_W1 (HNET_INPUTS * HNET_H1)
#define HNET_W2 (HNET_H1 * HNET_H2)
#define HNET_W3 (HNET_MOVES * HNET_H2)
#define HNET_FLOATS (HNET_W1 + HNET_H1 + HNET_W2 + HNET_H2 + HNET_W3 + HNET_MOVES + HNET_H2 + 1)

// Mirrored square for the side to move.
static inline int hnet_sq(int side, int sq) { return side == WHITE ? sq : sq ^ 56; }

// Policy index of a legal move in pos.
static inline int hnet_move_index(const Position* pos, Move m) {
    int from = move_from(m), to = move_to(m);
    // Castling is always e1 -> g1/c1, wherever the king starts (Chess960): the net learned
    // "castle short/long" from that index, and a king step such as b1-c1 keeps its own.
    if (move_is_castle(m)) {
        from = make_square(rank_of(from), 4);
        to = make_square(rank_of(from), move_flags(m) == FLAG_KING_CASTLE ? 6 : 2);
    }
    return hnet_sq(pos->side, from) * 64 + hnet_sq(pos->side, to);
}

// The side-to-move view of pos (board[] and castling as in HSample).
static inline void hnet_encode(const Position* pos, uint8_t board[64], uint8_t* castling) {
    int us = pos->side;
    for (int sq = 0; sq < 64; ++sq) {
        int pc = pos->board[sq];
        board[hnet_sq(us, sq)] = pc == NO_PIECE ? 12 : (uint8_t)((piece_color(pc) == us ? 0 : 6) + piece_type(pc));
    }
    int c = pos->st->castling, own = us == WHITE ? 0 : 2, opp = 2 - own;
    *castling = (uint8_t)(((c >> own) & 3) | (((c >> opp) & 3) << 2));
}

// Indices of the active input features (at most 32 pieces + 4 rights). Returns the count.
static inline int hnet_features(const uint8_t board[64], uint8_t castling, int out[40]) {
    int n = 0;
    for (int sq = 0; sq < 64; ++sq)
        if (board[sq] != 12) out[n++] = board[sq] * 64 + sq;
    for (int i = 0; i < 4; ++i)
        if (castling & (1 << i)) out[n++] = 12 * 64 + i;
    return n;
}

#endif
