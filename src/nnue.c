#include "nnue.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Network: (768 * king buckets -> NNUE_HIDDEN) x 2 perspectives -> SCReLU -> 1 of 8 outputs.
//
// Input features are (king bucket, piece, square) seen from each side. The king bucket is
// taken from the perspective's own king square; if that king stands on files e-h, the whole
// board is mirrored left-right so the king is always on files a-d. With one king bucket
// (older "DCH2" networks) there is neither bucketing nor mirroring.

#define INPUTS 768
#define MAX_KING_BUCKETS 8
#define OUT_BUCKETS 8
#define MAGIC_V2 0x32484344u  // "DCH2": header {magic, hidden, output buckets}
#define MAGIC_V3 0x33484344u  // "DCH3": header {magic, hidden, output buckets, king buckets}
#define QA 255
#define QB 64
#define SCALE 150  // must match tools/nnue/trainer.c

int g_use_nnue = 0;

static int16_t ft_weights[MAX_KING_BUCKETS * INPUTS][NNUE_HIDDEN];
static int16_t ft_bias[NNUE_HIDDEN];
static int16_t out_weights[OUT_BUCKETS][2 * NNUE_HIDDEN];
static int32_t out_bias[OUT_BUCKETS];
static int king_buckets = 1;

// King bucket by king square (after flipping to the perspective's view and mirroring to
// files a-d), indexed rank * 4 + file. Must match tools/nnue/trainer.c.
static const int KING_BUCKET_LAYOUT[32] = {
    0, 1, 2, 3,
    4, 4, 5, 5,
    6, 6, 6, 6,
    6, 6, 6, 6,
    7, 7, 7, 7,
    7, 7, 7, 7,
    7, 7, 7, 7,
    7, 7, 7, 7,
};

// Provided by the generated src/nnue_net.c (size 0 if no network is embedded).
extern const unsigned char NNUE_EMBEDDED[];
extern const size_t NNUE_EMBEDDED_SIZE;

static size_t body_size(int kb) {
    return (size_t)kb * INPUTS * NNUE_HIDDEN * sizeof(int16_t) + sizeof(ft_bias) + sizeof(out_weights) +
           sizeof(out_bias);
}
#define MAX_NET_SIZE (4 * sizeof(uint32_t) + MAX_KING_BUCKETS * INPUTS * NNUE_HIDDEN * sizeof(int16_t) + \
                      sizeof(ft_bias) + sizeof(out_weights) + sizeof(out_bias))

static int load_memory(const unsigned char* data, size_t size) {
    // The file is little-endian, like every platform this engine targets.
    uint32_t header[4] = {0, 0, 0, 1};
    if (size < 3 * sizeof(uint32_t)) return 0;
    memcpy(header, data, 3 * sizeof(uint32_t));
    size_t header_size = 3 * sizeof(uint32_t);
    if (header[0] == MAGIC_V3) {
        if (size < 4 * sizeof(uint32_t)) return 0;
        memcpy(&header[3], data + header_size, sizeof(uint32_t));
        header_size += sizeof(uint32_t);
    } else if (header[0] != MAGIC_V2) {
        return 0;
    }
    int kb = (int)header[3];
    if (header[1] != NNUE_HIDDEN || header[2] != OUT_BUCKETS || kb < 1 || kb > MAX_KING_BUCKETS) return 0;
    if (size != header_size + body_size(kb)) return 0;

    data += header_size;
    size_t ft_size = (size_t)kb * INPUTS * NNUE_HIDDEN * sizeof(int16_t);
    memcpy(ft_weights, data, ft_size);
    data += ft_size;
    memcpy(ft_bias, data, sizeof(ft_bias));
    data += sizeof(ft_bias);
    memcpy(out_weights, data, sizeof(out_weights));
    data += sizeof(out_weights);
    memcpy(out_bias, data, sizeof(out_bias));
    king_buckets = kb;
    return 1;
}

int nnue_init(void) {
    g_use_nnue = load_memory(NNUE_EMBEDDED, NNUE_EMBEDDED_SIZE);
    return g_use_nnue;
}

int nnue_load_file(const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) return 0;
    unsigned char* buf = (unsigned char*)malloc(MAX_NET_SIZE + 1);
    size_t n = buf ? fread(buf, 1, MAX_NET_SIZE + 1, f) : 0;
    fclose(f);
    int ok = buf && load_memory(buf, n);
    free(buf);
    if (ok) g_use_nnue = 1;
    return ok;
}

// Everything a perspective's feature indices depend on: bucket offset and mirroring.
typedef struct {
    int offset;  // king bucket * 768
    int flip;    // XOR applied to relative squares: 56 for Black's view, | 7 when mirrored
} KingView;

static inline KingView king_view(int perspective, int king_sq) {
    KingView kv;
    int flip = perspective == WHITE ? 0 : 56;
    if (king_buckets == 1) {
        kv.offset = 0;
        kv.flip = flip;
        return kv;
    }
    int rel = king_sq ^ flip;
    if (file_of(rel) >= 4) {
        flip ^= 7;
        rel ^= 7;
    }
    kv.offset = KING_BUCKET_LAYOUT[rank_of(rel) * 4 + file_of(rel)] * INPUTS;
    kv.flip = flip;
    return kv;
}

static inline int same_view(KingView a, KingView b) { return a.offset == b.offset && a.flip == b.flip; }

static inline int feature(int perspective, KingView kv, int piece, int sq) {
    int color = piece_color(piece), type = piece_type(piece);
    return kv.offset + (color == perspective ? 0 : 384) + type * 64 + (sq ^ kv.flip);
}

static void refresh(const Position* pos, Accumulator* acc, int p) {
    KingView kv = king_view(p, king_square(pos, p));
    int16_t* v = acc->values[p];
    memcpy(v, ft_bias, sizeof(ft_bias));
    Bitboard occ = pos->occupied;
    while (occ) {
        int sq = pop_lsb(&occ);
        const int16_t* w = ft_weights[feature(p, kv, pos->board[sq], sq)];
        for (int h = 0; h < NNUE_HIDDEN; ++h) v[h] += w[h];
    }
    acc->computed[p] = 1;
}

// dst = src + sum(added rows) - sum(removed rows) for perspective p, in one pass.
static void update(Accumulator* dst, const Accumulator* src, const DirtyPieces* d, int p, KingView kv) {
    const int16_t* add[3];
    const int16_t* sub[3];
    int na = 0, ns = 0;
    for (int i = 0; i < d->count; ++i) {
        if (d->from[i] != NO_SQ) sub[ns++] = ft_weights[feature(p, kv, d->piece[i], d->from[i])];
        if (d->to[i] != NO_SQ) add[na++] = ft_weights[feature(p, kv, d->piece[i], d->to[i])];
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
    dst->computed[p] = 1;
}

// Did the move that led to `st` move p's king into a different bucket / mirror half?
static int king_view_changed(const State* st, int p) {
    const DirtyPieces* d = &st->dirty;
    int king = make_piece(p, KING);
    for (int i = 0; i < d->count; ++i)
        if (d->piece[i] == king && d->from[i] != NO_SQ && d->to[i] != NO_SQ)
            return !same_view(king_view(p, d->from[i]), king_view(p, d->to[i]));
    return 0;
}

// Bring perspective p of the current accumulator up to date: replay updates from the
// closest computed ancestor, or rebuild from the board if the king changed its bucket on
// the way (the board of intermediate states is not available, only the current one).
static void make_current(Position* pos, int p) {
    int idx = (int)(pos->st - pos->states);
    int k = idx;
    while (!pos->acc[k].computed[p]) {
        if (k == 0 || king_view_changed(&pos->states[k], p)) {
            refresh(pos, &pos->acc[idx], p);
            return;
        }
        k--;
    }
    KingView kv = king_view(p, king_square(pos, p));  // constant along the replayed path
    for (int m = k + 1; m <= idx; ++m) update(&pos->acc[m], &pos->acc[m - 1], &pos->states[m].dirty, p, kv);
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
    make_current(pos, WHITE);
    make_current(pos, BLACK);

#ifdef NNUE_VERIFY
    {
        static Accumulator check;
        static long long mismatches, checks;
        refresh(pos, &check, WHITE);
        refresh(pos, &check, BLACK);
        checks++;
        if (memcmp(check.values, pos->acc[idx].values, sizeof(check.values))) {
            if (++mismatches <= 5) fprintf(stderr, "NNUE accumulator mismatch at ply %d\n", idx);
        }
        if ((checks & 0xFFFFF) == 0) fprintf(stderr, "nnue verify: %lld checks, %lld mismatches\n", checks, mismatches);
    }
#endif
    const Accumulator* acc = &pos->acc[idx];
    int stm = pos->side;
    int bucket = (popcount(pos->occupied) - 2) / 4;
    if (bucket >= OUT_BUCKETS) bucket = OUT_BUCKETS - 1;
    int64_t sum = (int64_t)screlu_dot(acc->values[stm], out_weights[bucket]) +
                  screlu_dot(acc->values[stm ^ 1], out_weights[bucket] + NNUE_HIDDEN);
    int64_t out = sum / QA + out_bias[bucket];
    return (int)(out * SCALE / (QA * QB));
}
