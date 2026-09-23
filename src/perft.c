#include "perft.h"
#include "movegen.h"
#include "util.h"

#include <stdio.h>

static int hash_errors;

// Recomputes the incrementally maintained keys from scratch to verify make/unmake.
static int verify_state(const Position* pos) {
    static Position copy;  // static: Position is large (accumulators)
    char fen[128];
    pos_to_fen(pos, fen, sizeof(fen));
    pos_set_fen(&copy, fen);
    return copy.st->key == pos->st->key && copy.st->pawn_key == pos->st->pawn_key &&
           copy.st->psq_mg == pos->st->psq_mg && copy.st->psq_eg == pos->st->psq_eg &&
           copy.st->phase == pos->st->phase;
}

static uint64_t perft_rec(Position* pos, int depth, int verify) {
    MoveList list;
    generate_moves(pos, &list, GEN_ALL);
    uint64_t nodes = 0;
    for (int i = 0; i < list.count; ++i) {
        Move m = list.moves[i].move;
        if (!pos_is_legal(pos, m)) continue;
        if (depth == 1 && !verify) { nodes++; continue; }
        pos_make_move(pos, m);
        if (verify && !verify_state(pos)) hash_errors++;
        nodes += depth > 1 ? perft_rec(pos, depth - 1, verify) : 1;
        pos_unmake_move(pos, m);
    }
    return nodes;
}

uint64_t perft(Position* pos, int depth) {
    return depth > 0 ? perft_rec(pos, depth, 0) : 1;
}

void perft_divide(Position* pos, int depth) {
    long long start = now_ms();
    hash_errors = 0;
    MoveList list;
    generate_legal(pos, &list);
    uint64_t total = 0;
    // Full state verification is slow; only do it for shallow perfts.
    int verify = depth <= 4;
    for (int i = 0; i < list.count; ++i) {
        Move m = list.moves[i].move;
        pos_make_move(pos, m);
        if (verify && !verify_state(pos)) hash_errors++;
        uint64_t cnt = depth > 1 ? perft_rec(pos, depth - 1, verify) : 1;
        pos_unmake_move(pos, m);
        char buf[6];
        move_to_str(m, buf);
        printf("%s: %llu\n", buf, (unsigned long long)cnt);
        total += cnt;
    }
    long long ms = now_ms() - start;
    printf("\nNodes searched: %llu\nTime: %lld ms\n", (unsigned long long)total, ms);
    if (hash_errors) printf("HASH ERRORS: %d\n", hash_errors);
    fflush(stdout);
}
