// Texel tuner for the hand-crafted evaluation.
//
// The evaluation is linear in its weights (apart from the phase taper and the endgame
// scale factor, which are recorded per position). For every training position we trace
// how often each weight is applied for White and Black, then minimise
//     mean (result - sigmoid(K * eval / 400))^2
// over all weights with Adam, using full-batch gradients computed in parallel.
//
// Build:  make tuner
// Usage:  bin/tuner [-n max_positions] [-e epochs] [-lr rate] [-reg l2] data/*.txt > tuned.txt

#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "eval.h"
#include "position.h"

#define THREADS 16
#define N EVAL_PARAM_COUNT

typedef struct {
    int offset, count;   // slice of the global feature arrays
    float result;        // 1 / 0.5 / 0 from White's view
    uint8_t phase, scale;
} Sample;

static Sample* samples;
static int sample_count, sample_cap;
static uint16_t* feat_index;
static int16_t* feat_coeff;
static long long feat_count, feat_cap;

static double weights[N][2];  // [mg, eg]
static double initial[N][2];  // starting values; L2 regularisation pulls towards them
static double reg = 0.0;
static double K = 1.0;

#define VERIFY_COUNT 20000
static int true_eval[VERIFY_COUNT];  // engine eval (White's view) for a consistency check

static void add_sample(const Position* pos, double result) {
    int e = evaluate(pos);  // also fills the trace T
    if (sample_count < VERIFY_COUNT) true_eval[sample_count] = pos->side == WHITE ? e : -e;
    if (sample_count == sample_cap) {
        sample_cap = sample_cap ? sample_cap * 2 : 1 << 20;
        samples = realloc(samples, sizeof(Sample) * sample_cap);
    }
    Sample* s = &samples[sample_count++];
    s->offset = (int)feat_count;
    s->count = 0;
    s->result = (float)result;
    s->phase = (uint8_t)T.phase;
    s->scale = (uint8_t)T.scale;
    for (int i = 0; i < N; ++i) {
        int diff = T.coeff[i][WHITE] - T.coeff[i][BLACK];
        if (!diff) continue;
        if (feat_count == feat_cap) {
            feat_cap = feat_cap ? feat_cap * 2 : 1 << 24;
            feat_index = realloc(feat_index, sizeof(uint16_t) * feat_cap);
            feat_coeff = realloc(feat_coeff, sizeof(int16_t) * feat_cap);
        }
        feat_index[feat_count] = (uint16_t)i;
        feat_coeff[feat_count] = (int16_t)diff;
        feat_count++;
        s->count++;
    }
}

static inline double linear_eval(const Sample* s) {
    double mg = 0, eg = 0;
    for (int j = 0; j < s->count; ++j) {
        int i = feat_index[s->offset + j];
        double c = feat_coeff[s->offset + j];
        mg += c * weights[i][0];
        eg += c * weights[i][1];
    }
    return (mg * s->phase + eg * (24 - s->phase) * s->scale / 128.0) / 24.0;
}

static inline double sigmoid(double e) { return 1.0 / (1.0 + pow(10.0, -K * e / 400.0)); }

// ---------------------------------------------------------------------------
// Parallel loss / gradient
// ---------------------------------------------------------------------------

typedef struct {
    int begin, end;
    double loss;
    double grad[N][2];
    int want_grad;
} Job;

static void* worker(void* arg) {
    Job* job = (Job*)arg;
    job->loss = 0;
    if (job->want_grad) memset(job->grad, 0, sizeof(job->grad));
    for (int k = job->begin; k < job->end; ++k) {
        const Sample* s = &samples[k];
        double e = linear_eval(s);
        double p = sigmoid(e);
        double err = p - s->result;
        job->loss += err * err;
        if (!job->want_grad) continue;
        double d = 2.0 * err * p * (1.0 - p) * log(10.0) * K / 400.0;
        double dmg = d * s->phase / 24.0;
        double deg = d * (24 - s->phase) * s->scale / (128.0 * 24.0);
        for (int j = 0; j < s->count; ++j) {
            int i = feat_index[s->offset + j];
            double c = feat_coeff[s->offset + j];
            job->grad[i][0] += c * dmg;
            job->grad[i][1] += c * deg;
        }
    }
    return NULL;
}

static Job jobs[THREADS];

static double compute(double grad[N][2]) {
    pthread_t threads[THREADS];
    int chunk = (sample_count + THREADS - 1) / THREADS;
    for (int t = 0; t < THREADS; ++t) {
        jobs[t].begin = t * chunk;
        jobs[t].end = (t + 1) * chunk < sample_count ? (t + 1) * chunk : sample_count;
        if (jobs[t].begin > jobs[t].end) jobs[t].begin = jobs[t].end;
        jobs[t].want_grad = grad != NULL;
        pthread_create(&threads[t], NULL, worker, &jobs[t]);
    }
    double loss = 0;
    if (grad) memset(grad, 0, sizeof(double) * N * 2);
    for (int t = 0; t < THREADS; ++t) {
        pthread_join(threads[t], NULL);
        loss += jobs[t].loss;
        if (grad)
            for (int i = 0; i < N; ++i) {
                grad[i][0] += jobs[t].grad[i][0];
                grad[i][1] += jobs[t].grad[i][1];
            }
    }
    return loss / sample_count;
}

static void fit_k(void) {
    double lo = 0.2, hi = 3.0;
    for (int it = 0; it < 40; ++it) {
        double m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
        K = m1;
        double l1 = compute(NULL);
        K = m2;
        double l2 = compute(NULL);
        if (l1 < l2) hi = m2;
        else lo = m1;
    }
    K = (lo + hi) / 2;
}

// ---------------------------------------------------------------------------

static void load_file(const char* path, int max_positions) {
    FILE* f = fopen(path, "r");
    if (!f) {
        fprintf(stderr, "cannot open %s\n", path);
        return;
    }
    static Position pos;
    char line[512];
    while (sample_count < max_positions && fgets(line, sizeof(line), f)) {
        char* bar1 = strchr(line, '|');
        char* bar2 = bar1 ? strchr(bar1 + 1, '|') : NULL;
        if (!bar2) continue;
        *bar1 = '\0';
        double result = atof(bar2 + 1);
        if (!pos_set_fen(&pos, line)) continue;
        add_sample(&pos, result);
    }
    fclose(f);
}

int main(int argc, char** argv) {
    int max_positions = 100000000, epochs = 2000;
    double lr = 1.0;
    int first_file = 1;
    for (; first_file < argc && argv[first_file][0] == '-'; first_file += 2) {
        if (first_file + 1 >= argc) break;
        if (!strcmp(argv[first_file], "-n")) max_positions = atoi(argv[first_file + 1]);
        else if (!strcmp(argv[first_file], "-e")) epochs = atoi(argv[first_file + 1]);
        else if (!strcmp(argv[first_file], "-lr")) lr = atof(argv[first_file + 1]);
        else if (!strcmp(argv[first_file], "-reg")) reg = atof(argv[first_file + 1]);
    }

    bitboards_init();
    position_init();
    eval_init();

    for (int i = first_file; i < argc; ++i) load_file(argv[i], max_positions);
    fprintf(stderr, "positions: %d, features: %lld (%.1f per position), params: %d\n", sample_count, feat_count,
            (double)feat_count / (sample_count ? sample_count : 1), N);
    if (!sample_count) return 1;

    const Score* flat = (const Score*)&P;
    for (int i = 0; i < N; ++i) {
        weights[i][0] = mg_value(flat[i]);
        weights[i][1] = eg_value(flat[i]);
        initial[i][0] = weights[i][0];
        initial[i][1] = weights[i][1];
    }

    // The linear model must reproduce the engine's evaluation (up to integer rounding).
    int verify = sample_count < VERIFY_COUNT ? sample_count : VERIFY_COUNT, bad = 0;
    for (int k = 0; k < verify; ++k)
        if (fabs(linear_eval(&samples[k]) - true_eval[k]) > 2.0) bad++;
    fprintf(stderr, "trace check: %d of %d positions differ by more than 2 cp\n", bad, verify);

    fit_k();
    fprintf(stderr, "K = %.4f, initial loss = %.6f\n", K, compute(NULL));

    static double grad[N][2], m[N][2], v[N][2];
    const double b1 = 0.9, b2 = 0.999, eps = 1e-8;
    for (int epoch = 1; epoch <= epochs; ++epoch) {
        double loss = compute(grad);
        for (int i = 0; i < N; ++i)
            for (int k = 0; k < 2; ++k) {
                double g = grad[i][k] / sample_count + 2.0 * reg * (weights[i][k] - initial[i][k]);
                m[i][k] = b1 * m[i][k] + (1 - b1) * g;
                v[i][k] = b2 * v[i][k] + (1 - b2) * g * g;
                double mh = m[i][k] / (1 - pow(b1, epoch)), vh = v[i][k] / (1 - pow(b2, epoch));
                weights[i][k] -= lr * mh / (sqrt(vh) + eps);
            }
        if (epoch % 100 == 0 || epoch == 1) fprintf(stderr, "epoch %5d  loss %.6f\n", epoch, loss);
    }
    fprintf(stderr, "final loss = %.6f\n", compute(NULL));

    Score* out = (Score*)&P;
    for (int i = 0; i < N; ++i) out[i] = S((int)lround(weights[i][0]), (int)lround(weights[i][1]));
    eval_print_params();
    return 0;
}
