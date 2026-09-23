#include "tt.h"

#include <stdlib.h>
#include <string.h>

static TTBucket* table = NULL;
static size_t bucket_count = 0;
static uint8_t generation = 0;  // advances by 4 so the low 2 bits stay free for the bound

void tt_free(void) {
    free(table);
    table = NULL;
    bucket_count = 0;
}

void tt_resize(size_t mb) {
    if (mb < 1) mb = 1;
    tt_free();
    bucket_count = mb * 1024 * 1024 / sizeof(TTBucket);
    table = (TTBucket*)calloc(bucket_count, sizeof(TTBucket));
    if (!table) bucket_count = 0;
}

void tt_clear(void) {
    if (table) memset(table, 0, bucket_count * sizeof(TTBucket));
    generation = 0;
}

void tt_new_search(void) { generation = (uint8_t)(generation + 4); }

static inline TTBucket* bucket_for(uint64_t key) {
    // Lower 32 bits pick the bucket (multiply-shift, no modulo); upper 32 bits verify.
    return &table[((uint64_t)(uint32_t)key * (uint64_t)bucket_count) >> 32];
}

void tt_prefetch(uint64_t key) {
#if defined(__GNUC__) || defined(__clang__)
    if (table) __builtin_prefetch(bucket_for(key));
#else
    (void)key;
#endif
}

static inline int entry_age(const TTEntry* e) {
    return ((uint8_t)(generation - e->gen_bound) & 0xFC) >> 2;
}

TTEntry* tt_probe(uint64_t key, int* hit) {
    static TTEntry dummy;
    if (!table) {
        *hit = 0;
        memset(&dummy, 0, sizeof(dummy));
        return &dummy;
    }
    TTBucket* bucket = bucket_for(key);
    uint32_t key32 = (uint32_t)(key >> 32);
    TTEntry* replace = &bucket->entries[0];
    for (int i = 0; i < TT_BUCKET_SIZE; ++i) {
        TTEntry* e = &bucket->entries[i];
        if (e->key32 == key32 && e->depth) {
            *hit = 1;
            return e;
        }
        // Prefer replacing empty, old and shallow entries.
        if ((int)e->depth - 8 * entry_age(e) < (int)replace->depth - 8 * entry_age(replace)) replace = e;
    }
    *hit = 0;
    return replace;
}

void tt_store(TTEntry* e, uint64_t key, int depth, int score, int eval, int bound, Move move) {
    uint32_t key32 = (uint32_t)(key >> 32);
    if (move != MOVE_NONE || e->key32 != key32) e->move = move;
    if (bound == BOUND_EXACT || e->key32 != key32 || depth + 1 + 4 > e->depth || entry_age(e)) {
        e->key32 = key32;
        e->score = (int16_t)score;
        e->eval = (int16_t)eval;
        e->depth = (uint8_t)(depth + 1);
        e->gen_bound = (uint8_t)(generation | bound);
    }
}

int tt_hashfull(void) {
    if (!table || bucket_count < 200) return 0;
    int used = 0;
    for (int i = 0; i < 200; ++i)
        for (int j = 0; j < TT_BUCKET_SIZE; ++j) {
            const TTEntry* e = &table[i].entries[j];
            used += e->depth && (e->gen_bound & 0xFC) == generation;
        }
    return used * 1000 / (200 * TT_BUCKET_SIZE);
}
