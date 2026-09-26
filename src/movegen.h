#ifndef MOVEGEN_H
#define MOVEGEN_H

#include "position.h"

// Noisy = captures, en passant and queen promotions. Quiet = everything else
// (including all underpromotions). Noisy + quiet = all pseudo-legal moves.
enum { GEN_NOISY = 1, GEN_QUIET = 2, GEN_ALL = 3 };

void generate_moves(const Position* pos, MoveList* list, int type);
void generate_legal(const Position* pos, MoveList* list);
void generate_castling(const Position* pos, MoveList* list);  // appends castling moves

#endif
