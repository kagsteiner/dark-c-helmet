// NNUE trainer for Dark C. Helmet 2 (CPU, multithreaded, no dependencies besides pthreads).
//
// Network: (768 -> HIDDEN) x 2 perspectives -> SCReLU -> 1
//   Inputs are piece-square features seen from each side (own pieces first, board flipped
//   for Black). Both perspectives share the feature-transformer weights; the output layer
//   sees [side to move accumulator, other side accumulator].
//
// Target: blend of the search score and the game result, both from the side to move:
//   target = lambda * sigmoid(score / SCALE) + (1 - lambda) * wdl
// Loss:   (sigmoid(output) - target)^2, output is in units of SCALE centipawns.
//
// Usage:
//   trainer convert <out.bin> <in1.txt> [in2.txt ...]    text "fen | score | result" -> packed
//   trainer train <data.bin> <out.nnue> [epochs] [lr] [lambda]
//
// The .nnue file is quantised exactly as the engine expects (see src/nnue.c).

#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define HIDDEN 256
#define INPUTS 768
#define SCALE 400.0
#define QA 255
#define QB 64
#define THREADS 16
#define BATCH 16384
#define MAX_FEATURES 32

// ---------------------------------------------------------------------------
// Packed position format (32 bytes)
// ---------------------------------------------------------------------------

typedef struct {
    uint64_t occupancy;     // a1 = bit 0
    uint8_t pieces[16];     // 4 bits per occupied square, in bit order: color * 6 + type
    int16_t score;          // search score, White's view
    uint8_t result;         // 0 = black wins, 1 = draw, 2 = white wins
    uint8_t stm;            // 0 = white, 1 = black
    uint8_t padding[4];
} PackedPos;

static int pack_fen(const char* fen, PackedPos* out) {
    memset(out, 0, sizeof(*out));
    int board[64];
    for (int i = 0; i < 64; ++i) board[i] = -1;
    int rank = 7, file = 0;
    const char* c = fen;
    const char* chars = "PNBRQKpnbrqk";
    for (; *c && *c != ' '; ++c) {
        if (*c == '/') { rank--; file = 0; }
        else if (*c >= '1' && *c <= '8') file += *c - '0';
        else {
            const char* p = strchr(chars, *c);
            if (!p || rank < 0 || file > 7) return 0;
            board[rank * 8 + file] = (int)(p - chars);
            file++;
        }
    }
    if (*c != ' ') return 0;
    out->stm = c[1] == 'b';
    int n = 0;
    for (int sq = 0; sq < 64; ++sq) {
        if (board[sq] < 0) continue;
        if (n >= 32) return 0;
        out->occupancy |= 1ULL << sq;
        out->pieces[n / 2] |= (uint8_t)(board[sq] << (4 * (n & 1)));
        n++;
    }
    return 1;
}

// Feature index of a piece seen from `perspective`.
static inline int feature(int perspective, int piece, int sq) {
    int color = piece / 6, type = piece % 6;
    int rel_sq = perspective == 0 ? sq : sq ^ 56;
    return (color == perspective ? 0 : 384) + type * 64 + rel_sq;
}

static int extract(const PackedPos* p, int stm_feats[MAX_FEATURES], int nstm_feats[MAX_FEATURES]) {
    uint64_t occ = p->occupancy;
    int n = 0, stm = p->stm;
    while (occ) {
        int sq = __builtin_ctzll(occ);
        occ &= occ - 1;
        int piece = (p->pieces[n / 2] >> (4 * (n & 1))) & 15;
        stm_feats[n] = feature(stm, piece, sq);
        nstm_feats[n] = feature(stm ^ 1, piece, sq);
        n++;
    }
    return n;
}

static int convert(const char* out_path, int nfiles, char** files) {
    FILE* out = fopen(out_path, "wb");
    if (!out) return 1;
    long long total = 0;
    char line[512];
    for (int i = 0; i < nfiles; ++i) {
        FILE* in = fopen(files[i], "r");
        if (!in) { fprintf(stderr, "cannot open %s\n", files[i]); continue; }
        while (fgets(line, sizeof(line), in)) {
            char* bar1 = strchr(line, '|');
            char* bar2 = bar1 ? strchr(bar1 + 1, '|') : NULL;
            if (!bar2) continue;
            PackedPos p;
            if (!pack_fen(line, &p)) continue;
            int score = atoi(bar1 + 1);
            if (score > 32000) score = 32000;
            if (score < -32000) score = -32000;
            p.score = (int16_t)score;
            double r = atof(bar2 + 1);
            p.result = r > 0.75 ? 2 : r < 0.25 ? 0 : 1;
            fwrite(&p, sizeof(p), 1, out);
            total++;
        }
        fclose(in);
    }
    fclose(out);
    fprintf(stderr, "wrote %lld positions to %s\n", total, out_path);
    return 0;
}

// ---------------------------------------------------------------------------
// Network and training
// ---------------------------------------------------------------------------

typedef struct {
    float ft_w[INPUTS][HIDDEN];
    float ft_b[HIDDEN];
    float out_w[2 * HIDDEN];
    float out_b;
} Net;

#define NET_PARAMS ((int)(sizeof(Net) / sizeof(float)))

static Net net, adam_m, adam_v;
static PackedPos* data;
static long long data_count;
static int* order;
static double lambda_ = 0.75;

typedef struct {
    int begin, end;      // range in the current batch (indexes into order[])
    Net grad;
    double loss;
} Worker;

static Worker workers[THREADS];
static long long batch_start;

static inline float screlu(float x) {
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    return x * x;
}

static void* train_worker(void* arg) {
    Worker* w = (Worker*)arg;
    memset(&w->grad, 0, sizeof(Net));
    w->loss = 0;
    float acc[2][HIDDEN];
    int feats[2][MAX_FEATURES];
    for (int k = w->begin; k < w->end; ++k) {
        const PackedPos* p = &data[order[batch_start + k]];
        int n = extract(p, feats[0], feats[1]);

        for (int s = 0; s < 2; ++s) {
            memcpy(acc[s], net.ft_b, sizeof(acc[s]));
            for (int f = 0; f < n; ++f) {
                const float* row = net.ft_w[feats[s][f]];
                for (int h = 0; h < HIDDEN; ++h) acc[s][h] += row[h];
            }
        }
        float out = net.out_b;
        for (int s = 0; s < 2; ++s)
            for (int h = 0; h < HIDDEN; ++h) out += screlu(acc[s][h]) * net.out_w[s * HIDDEN + h];

        double score_stm = p->stm == 0 ? p->score : -p->score;
        double wdl = p->result / 2.0;
        if (p->stm == 1) wdl = 1.0 - wdl;
        double target = lambda_ * (1.0 / (1.0 + exp(-score_stm / SCALE))) + (1.0 - lambda_) * wdl;
        double pred = 1.0 / (1.0 + exp(-(double)out));
        double err = pred - target;
        w->loss += err * err;

        float g_out = (float)(2.0 * err * pred * (1.0 - pred));
        w->grad.out_b += g_out;
        for (int s = 0; s < 2; ++s) {
            float g_acc[HIDDEN];
            for (int h = 0; h < HIDDEN; ++h) {
                float a = acc[s][h];
                float clamped = a < 0 ? 0 : a > 1 ? 1 : a;
                w->grad.out_w[s * HIDDEN + h] += g_out * clamped * clamped;
                g_acc[h] = (a > 0 && a < 1) ? g_out * net.out_w[s * HIDDEN + h] * 2.0f * a : 0.0f;
            }
            for (int h = 0; h < HIDDEN; ++h) w->grad.ft_b[h] += g_acc[h];
            for (int f = 0; f < n; ++f) {
                float* row = w->grad.ft_w[feats[s][f]];
                for (int h = 0; h < HIDDEN; ++h) row[h] += g_acc[h];
            }
        }
    }
    return NULL;
}

static double validation_loss(long long count) {
    // Loss on the last `count` positions of the (unshuffled) data set, which are never trained on.
    double loss = 0;
    float acc[2][HIDDEN];
    int feats[2][MAX_FEATURES];
    for (long long i = data_count - count; i < data_count; ++i) {
        const PackedPos* p = &data[i];
        int n = extract(p, feats[0], feats[1]);
        for (int s = 0; s < 2; ++s) {
            memcpy(acc[s], net.ft_b, sizeof(acc[s]));
            for (int f = 0; f < n; ++f)
                for (int h = 0; h < HIDDEN; ++h) acc[s][h] += net.ft_w[feats[s][f]][h];
        }
        float out = net.out_b;
        for (int s = 0; s < 2; ++s)
            for (int h = 0; h < HIDDEN; ++h) out += screlu(acc[s][h]) * net.out_w[s * HIDDEN + h];
        double score_stm = p->stm == 0 ? p->score : -p->score;
        double wdl = p->result / 2.0;
        if (p->stm == 1) wdl = 1.0 - wdl;
        double target = lambda_ * (1.0 / (1.0 + exp(-score_stm / SCALE))) + (1.0 - lambda_) * wdl;
        double pred = 1.0 / (1.0 + exp(-(double)out));
        loss += (pred - target) * (pred - target);
    }
    return loss / count;
}

static uint64_t rng_state = 0x1234567;
static uint64_t rng(void) {
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 7;
    rng_state ^= rng_state << 17;
    return rng_state;
}
static double rand_uniform(void) { return (rng() >> 11) * (1.0 / 9007199254740992.0); }

static void init_net(void) {
    // Kaiming-like initialisation for the sparse input layer, small output weights.
    double ft_scale = 1.0 / sqrt(32.0);
    for (int i = 0; i < INPUTS; ++i)
        for (int h = 0; h < HIDDEN; ++h) net.ft_w[i][h] = (float)((rand_uniform() * 2 - 1) * ft_scale * 0.5);
    for (int h = 0; h < HIDDEN; ++h) net.ft_b[h] = 0.0f;
    double out_scale = 1.0 / sqrt(2.0 * HIDDEN);
    for (int h = 0; h < 2 * HIDDEN; ++h) net.out_w[h] = (float)((rand_uniform() * 2 - 1) * out_scale);
    net.out_b = 0.0f;
}

static void save_quantised(const char* path) {
    FILE* f = fopen(path, "wb");
    if (!f) return;
    // Clip to what int16 arithmetic in the engine can hold safely.
    for (int i = 0; i < INPUTS; ++i)
        for (int h = 0; h < HIDDEN; ++h) {
            long v = lround(net.ft_w[i][h] * QA);
            int16_t q = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
            fwrite(&q, 2, 1, f);
        }
    for (int h = 0; h < HIDDEN; ++h) {
        int16_t q = (int16_t)lround(net.ft_b[h] * QA);
        fwrite(&q, 2, 1, f);
    }
    for (int h = 0; h < 2 * HIDDEN; ++h) {
        long v = lround(net.out_w[h] * QB);
        int16_t q = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
        fwrite(&q, 2, 1, f);
    }
    int32_t ob = (int32_t)lround(net.out_b * QA * QB);
    fwrite(&ob, 4, 1, f);
    fclose(f);
}

static int train(const char* data_path, const char* out_path, int epochs, double lr) {
    FILE* f = fopen(data_path, "rb");
    if (!f) return 1;
    fseek(f, 0, SEEK_END);
    data_count = ftell(f) / (long long)sizeof(PackedPos);
    fseek(f, 0, SEEK_SET);
    data = malloc(sizeof(PackedPos) * data_count);
    if (fread(data, sizeof(PackedPos), data_count, f) != (size_t)data_count) return 1;
    fclose(f);

    long long validation = data_count / 100 < 200000 ? data_count / 100 : 200000;
    long long train_count = data_count - validation;
    order = malloc(sizeof(int) * train_count);
    for (long long i = 0; i < train_count; ++i) order[i] = (int)i;
    fprintf(stderr, "positions: %lld (training %lld, validation %lld), hidden %d, lambda %.2f\n",
            data_count, train_count, validation, HIDDEN, lambda_);

    init_net();
    const double b1 = 0.9, b2 = 0.999, eps = 1e-8, weight_decay = 0.01;
    long long step = 0;
    time_t start = time(NULL);

    for (int epoch = 1; epoch <= epochs; ++epoch) {
        // Learning-rate schedule: constant, then step down for the last epochs.
        double epoch_lr = lr * (epoch > epochs * 3 / 4 ? 0.1 : 1.0);
        for (long long i = train_count - 1; i > 0; --i) {
            long long j = (long long)(rng() % (uint64_t)(i + 1));
            int t = order[i];
            order[i] = order[j];
            order[j] = t;
        }
        double epoch_loss = 0;
        for (batch_start = 0; batch_start + BATCH <= train_count; batch_start += BATCH) {
            pthread_t threads[THREADS];
            for (int t = 0; t < THREADS; ++t) {
                workers[t].begin = t * BATCH / THREADS;
                workers[t].end = (t + 1) * BATCH / THREADS;
                pthread_create(&threads[t], NULL, train_worker, &workers[t]);
            }
            for (int t = 0; t < THREADS; ++t) pthread_join(threads[t], NULL);

            step++;
            float* params = (float*)&net;
            float* m = (float*)&adam_m;
            float* v = (float*)&adam_v;
            double c1 = 1 - pow(b1, (double)step), c2 = 1 - pow(b2, (double)step);
            for (int i = 0; i < NET_PARAMS; ++i) {
                double g = 0;
                for (int t = 0; t < THREADS; ++t) g += ((float*)&workers[t].grad)[i];
                g /= BATCH;
                m[i] = (float)(b1 * m[i] + (1 - b1) * g);
                v[i] = (float)(b2 * v[i] + (1 - b2) * g * g);
                double update = (m[i] / c1) / (sqrt(v[i] / c2) + eps);
                params[i] -= (float)(epoch_lr * (update + weight_decay * params[i]));
            }
            // Keep feature weights inside the range the int16 quantisation can represent.
            for (int i = 0; i < INPUTS; ++i)
                for (int h = 0; h < HIDDEN; ++h) {
                    float* x = &net.ft_w[i][h];
                    if (*x > 1.98f) *x = 1.98f;
                    if (*x < -1.98f) *x = -1.98f;
                }
            for (int t = 0; t < THREADS; ++t) epoch_loss += workers[t].loss;
        }
        double train_loss = epoch_loss / (double)(train_count / BATCH * BATCH);
        fprintf(stderr, "epoch %3d  lr %.5f  train loss %.6f  validation loss %.6f  (%ld s)\n", epoch, epoch_lr,
                train_loss, validation_loss(validation), (long)(time(NULL) - start));
        save_quantised(out_path);
    }
    return 0;
}

int main(int argc, char** argv) {
    if (argc >= 4 && !strcmp(argv[1], "convert")) return convert(argv[2], argc - 3, argv + 3);
    if (argc >= 4 && !strcmp(argv[1], "train")) {
        int epochs = argc > 4 ? atoi(argv[4]) : 20;
        double lr = argc > 5 ? atof(argv[5]) : 0.001;
        if (argc > 6) lambda_ = atof(argv[6]);
        return train(argv[2], argv[3], epochs, lr);
    }
    fprintf(stderr,
            "usage:\n  trainer convert <out.bin> <in.txt>...\n"
            "  trainer train <data.bin> <out.nnue> [epochs=20] [lr=0.001] [lambda=0.75]\n");
    return 1;
}
