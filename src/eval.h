#ifndef EVAL_H
#define EVAL_H

#include "position.h"

// A Score packs a middlegame and an endgame value into one int.
typedef int Score;
#define S(mg, eg) ((int)((unsigned int)(eg) << 16) + (mg))
static inline int mg_value(Score s) { return (int16_t)(uint16_t)(unsigned int)s; }
static inline int eg_value(Score s) { return (int16_t)(uint16_t)((unsigned int)(s + 0x8000) >> 16); }

// All tunable evaluation weights. The tuner treats this struct as a flat Score array.
typedef struct {
    Score material[6];
    Score psqt[6][64];          // white's view, a1 = 0
    Score bishop_pair;
    Score doubled_pawn;
    Score isolated_pawn;
    Score backward_pawn;
    Score passed_pawn[8];       // by relative rank
    Score passed_king_dist_us[8];    // x distance of own king to the square in front
    Score passed_king_dist_them[8];  // x distance of enemy king to the square in front
    Score passed_blocked[8];
    Score connected_pawn[8];
    Score knight_mobility[9];
    Score bishop_mobility[14];
    Score rook_mobility[15];
    Score queen_mobility[28];
    Score rook_open_file;
    Score rook_semi_open_file;
    Score knight_outpost;
    Score bishop_outpost;
    Score king_zone_attack[6];  // per attacked king-zone square, by attacker type
    Score safe_check[6];        // per safe checking square, by checker type
    Score king_shield[2];       // own pawns one / two ranks in front of the king
    Score king_open_file;       // files at/next to the king without own pawns
    Score threat_by_pawn[6];    // by victim type
    Score threat_by_minor[6];
    Score threat_by_rook[6];
    Score hanging;
    Score tempo;
} EvalParams;

#define EVAL_PARAM_COUNT ((int)(sizeof(EvalParams) / sizeof(Score)))

extern EvalParams P;

void eval_init(void);                // (re)build incremental PSQ tables from P
int evaluate(const Position* pos);   // from the side to move's point of view
void eval_print_params(void);        // print P as C source

#ifdef TUNE
// Linear-model trace: how often each parameter was applied for each color.
typedef struct {
    int coeff[EVAL_PARAM_COUNT][2];
    int phase;
    int scale;   // endgame scale factor (out of 128)
} EvalTrace;
extern EvalTrace T;
#endif

#endif
