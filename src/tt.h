#ifndef TT_H
#define TT_H

#include "types.h"

enum { BOUND_NONE = 0, BOUND_UPPER = 1, BOUND_LOWER = 2, BOUND_EXACT = 3 };

typedef struct {
    uint32_t key32;
    Move move;
    int16_t score;
    int16_t eval;
    uint8_t depth;      // stored depth + 1 (0 = empty); qsearch entries have depth 0
    uint8_t gen_bound;  // generation in the upper 6 bits, bound in the lower 2
} TTEntry;

#define TT_BUCKET_SIZE 5
typedef struct {
    TTEntry entries[TT_BUCKET_SIZE];
    char padding[4];
} TTBucket;  // 64 bytes: one cache line

void tt_resize(size_t mb);
void tt_clear(void);
void tt_new_search(void);
void tt_free(void);
int tt_hashfull(void);
void tt_prefetch(uint64_t key);

// Returns the entry to use for this key; *hit tells whether it holds this position.
TTEntry* tt_probe(uint64_t key, int* hit);
void tt_store(TTEntry* e, uint64_t key, int depth, int score, int eval, int bound, Move move);

static inline int tt_depth(const TTEntry* e) { return (int)e->depth - 1; }
static inline int tt_bound(const TTEntry* e) { return e->gen_bound & 3; }

// Mate scores are stored relative to the node, not the root.
static inline int score_to_tt(int score, int ply) {
    if (score >= VALUE_MATE_IN_MAX) return score + ply;
    if (score <= -VALUE_MATE_IN_MAX) return score - ply;
    return score;
}
static inline int score_from_tt(int score, int ply) {
    if (score == VALUE_NONE) return VALUE_NONE;
    if (score >= VALUE_MATE_IN_MAX) return score - ply;
    if (score <= -VALUE_MATE_IN_MAX) return score + ply;
    return score;
}

#endif
