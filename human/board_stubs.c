// The human player links the engine's board code (src/position.c, movegen.c, eval.c) but not
// its NNUE. eval.c refers to these two; the human player never calls evaluate().
#include "nnue.h"

int g_use_nnue = 0;
int nnue_evaluate(Position* pos) {
    (void)pos;
    return 0;
}
