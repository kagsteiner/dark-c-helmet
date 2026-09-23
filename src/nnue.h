#ifndef NNUE_H
#define NNUE_H

#include "position.h"

// Network: (768 -> NNUE_HIDDEN) x 2 perspectives -> SCReLU -> 1, trained with
// tools/nnue/trainer.c. Accumulators are updated incrementally from DirtyPieces.

extern int g_use_nnue;

int nnue_init(void);                          // load the embedded network; 0 if none
int nnue_load_file(const char* path);         // 1 on success
int nnue_evaluate(Position* pos);             // side to move's view, centipawns

#endif
