// Trainer for the human-like player's network (hnet.h): predicts the move a player of the
// training band played (policy, cross-entropy over all 4096 from-to pairs) and the game's
// result from the mover's view (value, logistic loss). Adam, cosine learning-rate decay.
// The dense layers use Accelerate (macOS); the sparse first layer runs on all cores.
//
//   bin/human-train train.bin val.bin out.hnet [--epochs 1] [--batch 1024] [--lr 0.001]
//                   [--max 0 (= all samples)] [--value-weight 1.0] [--seed 1]

#include <Accelerate/Accelerate.h>
#include <dispatch/dispatch.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>

#include "hnet.h"

static float* params;  // all weights, in file order (see hnet.h)
static float *grad, *adam_m, *adam_v;
static HNet net, dnet;

static void bind(HNet* n, float* base) {
    n->w1 = base;
    n->b1 = n->w1 + HNET_W1;
    n->w2 = n->b1 + HNET_H1;
    n->b2 = n->w2 + HNET_W2;
    n->w3 = n->b2 + HNET_H2;
    n->b3 = n->w3 + HNET_W3;
    n->w4 = n->b3 + HNET_MOVES;
    n->b4 = n->w4 + HNET_H2;
}

static uint64_t rng_state = 1;
static uint64_t rng(void) {
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 7;
    rng_state ^= rng_state << 17;
    return rng_state;
}
static float gauss(void) {
    double u = ((rng() >> 11) + 0.5) / 9007199254740992.0, v = ((rng() >> 11) + 0.5) / 9007199254740992.0;
    return (float)(sqrt(-2 * log(u)) * cos(2 * M_PI * v));
}

static const HSample* map_file(const char* path, size_t* count) {
    int fd = open(path, O_RDONLY);
    struct stat st;
    if (fd < 0 || fstat(fd, &st) < 0) {
        perror(path);
        exit(1);
    }
    void* p = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) {
        perror("mmap");
        exit(1);
    }
    *count = (size_t)st.st_size / sizeof(HSample);
    return p;
}

// Work buffers for one batch.
static int B;
static float *h1, *h2, *logits, *value, *dh1, *dh2, *dval;
static int (*feats)[40];
static int* nfeat;
static int* argmax;  // most likely move per sample (forward with softmax)
static float* ones;  // B ones, for column sums

// Forward pass over samples s[0..n). Fills h1, h2, logits (softmax probabilities if
// softmax), value (sigmoid).
static void forward(const HSample* const* s, int n, int softmax) {
    dispatch_apply((size_t)n, DISPATCH_APPLY_AUTO, ^(size_t b) {
        nfeat[b] = hnet_features(s[b]->board, s[b]->castling, feats[b]);
        float* h = h1 + b * HNET_H1;
        memcpy(h, net.b1, sizeof(float) * HNET_H1);
        for (int i = 0; i < nfeat[b]; ++i) {
            const float* w = net.w1 + (size_t)feats[b][i] * HNET_H1;
            for (int j = 0; j < HNET_H1; ++j) h[j] += w[j];
        }
        for (int j = 0; j < HNET_H1; ++j) h[j] = h[j] > 0 ? h[j] : 0;
    });
    for (int b = 0; b < n; ++b) memcpy(h2 + (size_t)b * HNET_H2, net.b2, sizeof(float) * HNET_H2);
    cblas_sgemm(CblasRowMajor, CblasNoTrans, CblasNoTrans, n, HNET_H2, HNET_H1, 1, h1, HNET_H1, net.w2, HNET_H2, 1,
                h2, HNET_H2);
    for (size_t i = 0; i < (size_t)n * HNET_H2; ++i) h2[i] = h2[i] > 0 ? h2[i] : 0;
    for (int b = 0; b < n; ++b) memcpy(logits + (size_t)b * HNET_MOVES, net.b3, sizeof(float) * HNET_MOVES);
    cblas_sgemm(CblasRowMajor, CblasNoTrans, CblasTrans, n, HNET_MOVES, HNET_H2, 1, h2, HNET_H2, net.w3, HNET_H2, 1,
                logits, HNET_MOVES);
    dispatch_apply((size_t)n, DISPATCH_APPLY_AUTO, ^(size_t b) {
        const float* x = h2 + b * HNET_H2;
        float v = net.b4[0];
        for (int j = 0; j < HNET_H2; ++j) v += x[j] * net.w4[j];
        value[b] = 1 / (1 + expf(-v));
        if (!softmax) return;
        float* l = logits + b * HNET_MOVES;
        float mx = l[0];
        for (int k = 1; k < HNET_MOVES; ++k) mx = l[k] > mx ? l[k] : mx;
        float sum = 0;
        int best = 0;
        for (int k = 0; k < HNET_MOVES; ++k) {
            if (l[k] == mx) best = k;
            sum += l[k] = expf(l[k] - mx);
        }
        for (int k = 0; k < HNET_MOVES; ++k) l[k] /= sum;
        argmax[b] = best;
    });
}

static float target_value(const HSample* s) { return (s->result + 1) * 0.5f; }

// Loss of the batch forward() just computed (needs softmax). Adds to the totals.
static void batch_loss(const HSample* const* s, int n, double* ce, double* vloss, long* top1) {
    for (int b = 0; b < n; ++b) {
        const float* p = logits + (size_t)b * HNET_MOVES;
        *ce -= log(p[s[b]->move] + 1e-12);
        *top1 += argmax[b] == s[b]->move;
        float t = target_value(s[b]), v = value[b];
        *vloss -= t * log(v + 1e-7) + (1 - t) * log(1 - v + 1e-7);
    }
}

static void backward(const HSample* const* s, int n, float value_weight) {
    memset(grad, 0, sizeof(float) * HNET_FLOATS);
    // Output gradients: softmax - one-hot, sigmoid - target, averaged over the batch.
    dispatch_apply((size_t)n, DISPATCH_APPLY_AUTO, ^(size_t b) {
        float* l = logits + b * HNET_MOVES;
        l[s[b]->move] -= 1;
        for (int k = 0; k < HNET_MOVES; ++k) l[k] /= n;
        dval[b] = value_weight * (value[b] - target_value(s[b])) / n;
    });
    // Policy layer.
    cblas_sgemm(CblasRowMajor, CblasTrans, CblasNoTrans, HNET_MOVES, HNET_H2, n, 1, logits, HNET_MOVES, h2, HNET_H2, 0,
                dnet.w3, HNET_H2);
    cblas_sgemv(CblasRowMajor, CblasTrans, n, HNET_MOVES, 1, logits, HNET_MOVES, ones, 1, 0, dnet.b3, 1);
    cblas_sgemm(CblasRowMajor, CblasNoTrans, CblasNoTrans, n, HNET_H2, HNET_MOVES, 1, logits, HNET_MOVES, net.w3,
                HNET_H2, 0, dh2, HNET_H2);
    // Value head, then the ReLU of layer 2.
    for (int b = 0; b < n; ++b) {
        const float* x = h2 + (size_t)b * HNET_H2;
        float* d = dh2 + (size_t)b * HNET_H2;
        dnet.b4[0] += dval[b];
        for (int j = 0; j < HNET_H2; ++j) {
            dnet.w4[j] += dval[b] * x[j];
            d[j] = x[j] > 0 ? d[j] + dval[b] * net.w4[j] : 0;
        }
    }
    cblas_sgemm(CblasRowMajor, CblasTrans, CblasNoTrans, HNET_H1, HNET_H2, n, 1, h1, HNET_H1, dh2, HNET_H2, 0, dnet.w2,
                HNET_H2);
    cblas_sgemv(CblasRowMajor, CblasTrans, n, HNET_H2, 1, dh2, HNET_H2, ones, 1, 0, dnet.b2, 1);
    cblas_sgemm(CblasRowMajor, CblasNoTrans, CblasTrans, n, HNET_H1, HNET_H2, 1, dh2, HNET_H2, net.w2, HNET_H2, 0, dh1,
                HNET_H1);
    for (size_t i = 0; i < (size_t)n * HNET_H1; ++i)
        if (h1[i] <= 0) dh1[i] = 0;
    // Sparse first layer: each worker owns a slice of the hidden units, so no two write the
    // same weight.
    enum { SLICES = 16, W = HNET_H1 / SLICES };
    dispatch_apply(SLICES, DISPATCH_APPLY_AUTO, ^(size_t slice) {
        int j0 = (int)slice * W;
        for (int b = 0; b < n; ++b) {
            const float* d = dh1 + (size_t)b * HNET_H1 + j0;
            for (int j = 0; j < W; ++j) dnet.b1[j0 + j] += d[j];
            for (int i = 0; i < nfeat[b]; ++i) {
                float* g = dnet.w1 + (size_t)feats[b][i] * HNET_H1 + j0;
                for (int j = 0; j < W; ++j) g[j] += d[j];
            }
        }
    });
}

static void adam(float lr, long step) {
    const float b1 = 0.9f, b2 = 0.999f, eps = 1e-8f;
    float c1 = 1 - powf(b1, (float)step), c2 = 1 - powf(b2, (float)step);
    enum { CHUNKS = 64 };
    size_t per = (HNET_FLOATS + CHUNKS - 1) / CHUNKS;
    dispatch_apply(CHUNKS, DISPATCH_APPLY_AUTO, ^(size_t c) {
        size_t end = (c + 1) * per < HNET_FLOATS ? (c + 1) * per : HNET_FLOATS;
        for (size_t i = c * per; i < end; ++i) {
            float g = grad[i];
            adam_m[i] = b1 * adam_m[i] + (1 - b1) * g;
            adam_v[i] = b2 * adam_v[i] + (1 - b2) * g * g;
            params[i] -= lr * (adam_m[i] / c1) / (sqrtf(adam_v[i] / c2) + eps);
        }
    });
}

static void save(const char* path) {
    FILE* f = fopen(path, "wb");
    if (!f) {
        perror(path);
        exit(1);
    }
    int32_t dims[4] = {HNET_INPUTS, HNET_H1, HNET_H2, HNET_MOVES};
    fwrite("HNET1\0\0\0", 1, 8, f);
    fwrite(dims, sizeof(dims), 1, f);
    fwrite(params, sizeof(float), HNET_FLOATS, f);
    fclose(f);
}

// Policy loss, top-1 match and value loss on (up to) 200,000 validation positions.
static void validate(const HSample* val, size_t nval, const char* label) {
    size_t step = nval > 200000 ? nval / 200000 : 1, count = 0;
    double ce = 0, vl = 0;
    long top1 = 0;
    const HSample* batch[4096];
    int n = 0;
    for (size_t i = 0; i < nval && count < 200000; i += step, ++count) {
        batch[n++] = &val[i];
        if (n == B || count + 1 == 200000 || i + step >= nval) {
            forward(batch, n, 1);
            batch_loss(batch, n, &ce, &vl, &top1);
            n = 0;
        }
    }
    printf("%s  val policy %.4f  move match %.2f%%  value %.4f  (%zu positions)\n", label, ce / count,
           100.0 * top1 / count, vl / count, count);
    fflush(stdout);
}

int main(int argc, char** argv) {
    if (argc < 4) {
        fprintf(stderr, "usage: human-train train.bin val.bin out.hnet [options]\n");
        return 1;
    }
    int epochs = 1;
    float lr0 = 1e-3f, value_weight = 1.0f;
    size_t max = 0;
    B = 1024;
    for (int i = 4; i + 1 < argc; i += 2) {
        if (!strcmp(argv[i], "--epochs")) epochs = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--batch")) B = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--lr")) lr0 = (float)atof(argv[i + 1]);
        else if (!strcmp(argv[i], "--max")) max = (size_t)atoll(argv[i + 1]);
        else if (!strcmp(argv[i], "--value-weight")) value_weight = (float)atof(argv[i + 1]);
        else if (!strcmp(argv[i], "--seed")) rng_state = (uint64_t)atoll(argv[i + 1]) * 2654435761u + 1;
    }
    if (B > 4096) B = 4096;
    size_t ntrain, nval;
    const HSample* train = map_file(argv[1], &ntrain);
    const HSample* val = map_file(argv[2], &nval);
    if (max && max < ntrain) ntrain = max;
    printf("train %zu positions, validation %zu, batch %d, %d epoch(s), lr %g\n", ntrain, nval, B, epochs, lr0);

    params = calloc(HNET_FLOATS, sizeof(float));
    grad = calloc(HNET_FLOATS, sizeof(float));
    adam_m = calloc(HNET_FLOATS, sizeof(float));
    adam_v = calloc(HNET_FLOATS, sizeof(float));
    bind(&net, params);
    bind(&dnet, grad);
    // He initialisation (the first layer sees about 33 active inputs).
    for (size_t i = 0; i < HNET_W1; ++i) net.w1[i] = gauss() * sqrtf(2.0f / 33);
    for (size_t i = 0; i < HNET_W2; ++i) net.w2[i] = gauss() * sqrtf(2.0f / HNET_H1);
    for (size_t i = 0; i < HNET_W3; ++i) net.w3[i] = gauss() * sqrtf(1.0f / HNET_H2);
    for (size_t i = 0; i < HNET_H2; ++i) net.w4[i] = gauss() * sqrtf(1.0f / HNET_H2);

    h1 = malloc(sizeof(float) * (size_t)B * HNET_H1);
    dh1 = malloc(sizeof(float) * (size_t)B * HNET_H1);
    h2 = malloc(sizeof(float) * (size_t)B * HNET_H2);
    dh2 = malloc(sizeof(float) * (size_t)B * HNET_H2);
    logits = malloc(sizeof(float) * (size_t)B * HNET_MOVES);
    value = malloc(sizeof(float) * (size_t)B);
    dval = malloc(sizeof(float) * (size_t)B);
    feats = malloc(sizeof(*feats) * (size_t)B);
    nfeat = malloc(sizeof(int) * (size_t)B);
    argmax = malloc(sizeof(int) * 4096);
    ones = malloc(sizeof(float) * 4096);
    for (int i = 0; i < 4096; ++i) ones[i] = 1;

    uint32_t* order = malloc(sizeof(uint32_t) * ntrain);
    for (size_t i = 0; i < ntrain; ++i) order[i] = (uint32_t)i;
    long steps_per_epoch = (long)(ntrain / (size_t)B), total = steps_per_epoch * epochs, step = 0;
    validate(val, nval, "start  ");
    time_t t0 = time(NULL);
    for (int e = 0; e < epochs; ++e) {
        for (size_t i = ntrain - 1; i > 0; --i) {
            size_t j = rng() % (i + 1);
            uint32_t t = order[i];
            order[i] = order[j];
            order[j] = t;
        }
        double ce = 0, vl = 0;
        long top1 = 0, seen = 0;
        for (long k = 0; k < steps_per_epoch; ++k) {
            const HSample* batch[4096];
            for (int b = 0; b < B; ++b) batch[b] = &train[order[(size_t)k * B + b]];
            forward(batch, B, 1);
            batch_loss(batch, B, &ce, &vl, &top1);
            seen += B;
            backward(batch, B, value_weight);
            ++step;
            float lr = lr0 * (0.02f + 0.98f * 0.5f * (1 + cosf((float)M_PI * step / total)));
            adam(lr, step);
            if (step % 2000 == 0) {
                long secs = (long)(time(NULL) - t0);
                printf("epoch %d  step %ld/%ld  train policy %.4f  match %.2f%%  value %.4f  lr %.2e  %lds (eta %ldm)\n",
                       e + 1, step, total, ce / seen, 100.0 * top1 / seen, vl / seen, lr, secs,
                       (long)((double)secs / step * (total - step) / 60));
                fflush(stdout);
                ce = vl = 0;
                top1 = seen = 0;
            }
            if (step % 50000 == 0) {
                save(argv[3]);
                validate(val, nval, "checkpoint");
            }
        }
        save(argv[3]);
        char label[32];
        snprintf(label, sizeof(label), "epoch %d", e + 1);
        validate(val, nval, label);
    }
    printf("saved %s\n", argv[3]);
    return 0;
}
