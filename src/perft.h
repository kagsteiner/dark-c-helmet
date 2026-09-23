#ifndef PERFT_H
#define PERFT_H

#include "position.h"

uint64_t perft(Position* pos, int depth);
void perft_divide(Position* pos, int depth);  // per-move counts, total, timing, hash check

#endif
