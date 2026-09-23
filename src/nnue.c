#include "nnue.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define INPUTS 768
#define QA 255
#define QB 64
#define SCALE 400

int g_use_nnue = 0;

static int16_t ft_weights[INPUTS][NNUE_HIDDEN];
static int16_t ft_bias[NNUE_HIDDEN];
static int16_t out_weights[2 * NNUE_HIDDEN];
static int32_t out_bias;

// Provided by the generated src/nnue_net.c (size 0 if no network is embedded).
extern const unsigned char NNUE_EMBEDDED[];
extern const size_t NNUE_EMBEDDED_SIZE;

#define NET_SIZE (sizeof(ft_weights) + sizeof(ft_bias) + sizeof(out_weights) + sizeof(out_bias))

static int load_memory(const unsigned char* data, size_t size) {
    if (size != NET_SIZE) return 0;
    // The file is little-endian, like every platform this engine targets.
    memcpy(ft_weights, data, sizeof(ft_weights));
    data += sizeof(ft_weights);
    memcpy(ft_bias, data, sizeof(ft_bias));
    data += sizeof(ft_bias);
    memcpy(out_weights, data, sizeof(out_weights));
    data += sizeof(out_weights);
    memcpy(&out_bias, data, sizeof(out_bias));
    return 1;
}

int nnue_init(void) {
    g_use_nnue = load_memory(NNUE_EMBEDDED, NNUE_EMBEDDED_SIZE);
    return g_use_nnue;
}

int nnue_load_file(const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) return 0;
    unsigned char* buf = (unsigned char*)malloc(NET_SIZE + 1);
    size_t n = buf ? fread(buf, 1, NET_SIZE + 1, f) : 0;
    fclose(f);
    int ok = buf && load_memory(buf, n);
    free(buf);
    if (ok) g_use_nnue = 1;
    return ok;
}

static inline int feature(int perspective, int piece, int sq) {
    int color = piece_color(piece), type = piece_type(piece);
    int rel = perspective == WHITE ? sq : sq ^ 56;
    return (color == perspective ? 0 : 384) + type * 64 + rel;
}

static void refresh(const Position* pos, Accumulator* acc) {
    for (int p = 0; p < 2; ++p) {
        int16_t* v = acc->values[p];
        memcpy(v, ft_bias, sizeof(ft_bias));
        Bitboard occ = pos->occupied;
        while (occ) {
            int sq = pop_lsb(&occ);
            const int16_t* w = ft_weights[feature(p, pos->board[sq], sq)];
            for (int h = 0; h < NNUE_HIDDEN; ++h) v[h] += w[h];
        }
    }
    acc->computed = 1;
}

// dst = src + sum(added rows) - sum(removed rows), in one pass per perspective.
static void update(Accumulator* dst, const Accumulator* src, const DirtyPieces* d) {
    for (int p = 0; p < 2; ++p) {
        const int16_t* add[3];
        const int16_t* sub[3];
        int na = 0, ns = 0;
        for (int i = 0; i < d->count; ++i) {
            if (d->from[i] != NO_SQ) sub[ns++] = ft_weights[feature(p, d->piece[i], d->from[i])];
            if (d->to[i] != NO_SQ) add[na++] = ft_weights[feature(p, d->piece[i], d->to[i])];
        }
        int16_t* v = dst->values[p];
        const int16_t* s = src->values[p];
        if (na == 1 && ns == 1) {  // quiet move
            const int16_t *a0 = add[0], *s0 = sub[0];
            for (int h = 0; h < NNUE_HIDDEN; ++h) v[h] = (int16_t)(s[h] + a0[h] - s0[h]);
        } else if (na == 1 && ns == 2) {  // capture or promotion
            const int16_t *a0 = add[0], *s0 = sub[0], *s1 = sub[1];
            for (int h = 0; h < NNUE_HIDDEN; ++h) v[h] = (int16_t)(s[h] + a0[h] - s0[h] - s1[h]);
        } else if (na == 2 && ns == 2) {  // castling
            const int16_t *a0 = add[0], *a1 = add[1], *s0 = sub[0], *s1 = sub[1];
            for (int h = 0; h < NNUE_HIDDEN; ++h) v[h] = (int16_t)(s[h] + a0[h] + a1[h] - s0[h] - s1[h]);
        } else {  // null move, promotion-capture
            memcpy(v, s, sizeof(dst->values[p]));
            for (int i = 0; i < ns; ++i)
                for (int h = 0; h < NNUE_HIDDEN; ++h) v[h] -= sub[i][h];
            for (int i = 0; i < na; ++i)
                for (int h = 0; h < NNUE_HIDDEN; ++h) v[h] += add[i][h];
        }
    }
    dst->computed = 1;
}

// Output weights are limited to |w| <= 127 by the trainer, so c * w fits in int16 and the
// int32 sum cannot overflow in practice; this form vectorises well.
static inline int32_t screlu_dot(const int16_t* v, const int16_t* w) {
    int32_t sum = 0;
    for (int h = 0; h < NNUE_HIDDEN; ++h) {
        int16_t c = v[h] < 0 ? 0 : v[h] > QA ? QA : v[h];
        int16_t cw = (int16_t)(c * w[h]);
        sum += (int32_t)cw * c;
    }
    return sum;
}

int nnue_evaluate(Position* pos) {
    int idx = (int)(pos->st - pos->states);
    // Bring the accumulator up to date from the closest computed ancestor.
    int j = idx;
    while (j > 0 && !pos->acc[j].computed) j--;
    if (!pos->acc[j].computed) {
        // Only the root state can be rebuilt from the board: earlier boards are gone.
        if (j != idx) {
            refresh(pos, &pos->acc[idx]);
            j = idx;
        } else {
            refresh(pos, &pos->acc[j]);
        }
    }
    for (int k = j + 1; k <= idx; ++k) update(&pos->acc[k], &pos->acc[k - 1], &pos->states[k].dirty);

#ifdef NNUE_VERIFY
    {
        static Accumulator check;
        static long long mismatches, checks;
        refresh(pos, &check);
        checks++;
        if (memcmp(check.values, pos->acc[idx].values, sizeof(check.values))) {
            if (++mismatches <= 5) fprintf(stderr, "NNUE accumulator mismatch at ply %d\n", idx);
        }
        if ((checks & 0xFFFFF) == 0) fprintf(stderr, "nnue verify: %lld checks, %lld mismatches\n", checks, mismatches);
    }
#endif
    const Accumulator* acc = &pos->acc[idx];
    int stm = pos->side;
    int64_t sum = (int64_t)screlu_dot(acc->values[stm], out_weights) +
                  screlu_dot(acc->values[stm ^ 1], out_weights + NNUE_HIDDEN);
    int64_t out = sum / QA + out_bias;
    return (int)(out * SCALE / (QA * QB));
}
