// Network inference for the human-like player (layout in hnet.h). The networks are embedded
// as 16-bit floats (human/hnet_data.c, written by human/embed.py), one per rating band, and
// expanded when first used. Only the policy logits of the legal moves are computed.

#include "hnet_eval.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "movegen.h"

typedef struct {
    const char* name;  // "h1300_v1": band 1300, version 1
    const uint16_t* data;
    unsigned count;
} EmbeddedNet;
extern const EmbeddedNet HNET_EMBEDDED[];
extern const int HNET_EMBEDDED_NETS;

static HNet net;
static float* weights;
static const char* current;

static float half_to_float(uint16_t h) {
    int sign = h >> 15, exp = (h >> 10) & 31, man = h & 1023;
    float v = exp == 0 ? ldexpf((float)man, -24) : exp == 31 ? INFINITY : ldexpf((float)(man | 1024), exp - 25);
    return sign ? -v : v;
}

const char* hnet_use(const char* band) {
    const EmbeddedNet* e = NULL;
    for (int i = 0; i < HNET_EMBEDDED_NETS; ++i)
        if (HNET_EMBEDDED[i].name[0] == 'h' && !strncmp(HNET_EMBEDDED[i].name + 1, band, strlen(band)) &&
            HNET_EMBEDDED[i].name[1 + strlen(band)] == '_' && HNET_EMBEDDED[i].count == HNET_FLOATS)
            e = &HNET_EMBEDDED[i];
    if (!e) return NULL;
    if (current == e->name) return current;
    if (!weights) weights = malloc(sizeof(float) * HNET_FLOATS);
    for (unsigned i = 0; i < HNET_FLOATS; ++i) weights[i] = half_to_float(e->data[i]);
    current = e->name;
    net.w1 = weights;
    net.b1 = net.w1 + HNET_W1;
    net.w2 = net.b1 + HNET_H1;
    net.b2 = net.w2 + HNET_W2;
    net.w3 = net.b2 + HNET_H2;
    net.b3 = net.w3 + HNET_W3;
    net.w4 = net.b3 + HNET_MOVES;
    net.b4 = net.w4 + HNET_H2;
    return current;
}

void hnet_evaluate(const Position* pos, HEval* out) {
    uint8_t board[64], castling;
    int feats[40];
    hnet_encode(pos, board, &castling);
    int n = hnet_features(board, castling, feats);

    float h1[HNET_H1], h2[HNET_H2];
    memcpy(h1, net.b1, sizeof(h1));
    for (int i = 0; i < n; ++i) {
        const float* w = net.w1 + (size_t)feats[i] * HNET_H1;
        for (int j = 0; j < HNET_H1; ++j) h1[j] += w[j];
    }
    memcpy(h2, net.b2, sizeof(h2));
    for (int i = 0; i < HNET_H1; ++i) {
        float x = h1[i];
        if (x <= 0) continue;
        const float* w = net.w2 + (size_t)i * HNET_H2;
        for (int j = 0; j < HNET_H2; ++j) h2[j] += x * w[j];
    }
    float v = net.b4[0];
    for (int j = 0; j < HNET_H2; ++j) {
        h2[j] = h2[j] > 0 ? h2[j] : 0;
        v += h2[j] * net.w4[j];
    }
    out->value = 1 / (1 + expf(-v));

    // Policy over the legal moves (underpromotions share their pawn move's logit and are
    // left out: the player always promotes to a queen).
    MoveList list;
    generate_legal(pos, &list);
    out->count = 0;
    float mx = -INFINITY;
    for (int i = 0; i < list.count; ++i) {
        Move m = list.moves[i].move;
        if (move_is_promo(m) && move_promo_type(m) != QUEEN) continue;
        int k = hnet_move_index(pos, m);
        const float* w = net.w3 + (size_t)k * HNET_H2;
        float l = net.b3[k];
        for (int j = 0; j < HNET_H2; ++j) l += h2[j] * w[j];
        out->moves[out->count] = m;
        out->prob[out->count++] = l;
        if (l > mx) mx = l;
    }
    float sum = 0;
    for (int i = 0; i < out->count; ++i) sum += out->prob[i] = expf(out->prob[i] - mx);
    for (int i = 0; i < out->count; ++i) out->prob[i] /= sum;
    // Most likely first.
    for (int i = 1; i < out->count; ++i)
        for (int j = i; j > 0 && out->prob[j] > out->prob[j - 1]; --j) {
            float p = out->prob[j];
            out->prob[j] = out->prob[j - 1];
            out->prob[j - 1] = p;
            Move m = out->moves[j];
            out->moves[j] = out->moves[j - 1];
            out->moves[j - 1] = m;
        }
}
