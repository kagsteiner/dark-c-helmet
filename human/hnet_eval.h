// The human-like player's view of a position: who is better and which moves come to mind.
#ifndef HNET_EVAL_H
#define HNET_EVAL_H

#include "hnet.h"

typedef struct {
    float value;            // chance that the side to move wins (draw = half)
    int count;              // legal moves (underpromotions left out)
    Move moves[MAX_MOVES];  // most likely first
    float prob[MAX_MOVES];  // how likely a player of the band plays each
} HEval;

// Switches to the embedded network of a rating band ("1300"). Returns its name ("h1300_v1"),
// or NULL if none is embedded for that band.
const char* hnet_use(const char* band);
void hnet_evaluate(const Position* pos, HEval* out);

#endif
