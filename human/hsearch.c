// The human-like player's search (see hsearch.h).
//
// For each candidate A (the policy's favourites, in an order with some randomness):
//   - the opponent's replies to A, most obvious first, some overlooked ("blind"); the first
//     `replies` that are seen are checked;
//   - after each reply B the line is followed with the most likely move of each side
//     (line_depth plies after the obvious reply, alt_depth after the others; a capture at
//     the end is answered, up to two extra plies);
//   - the value at the end of the line counts; A is worth the worst checked reply, softened
//     by optimism towards their average.
// The first candidate that looks clearly better than the position is played at once.

#include "hsearch.h"

#include <math.h>
#include <string.h>

// One profile per band, each with its own net (see README.md). Named fields: the order of
// HProfile is easy to get wrong.
const HProfile HPROFILES[] = {
    {.name = "1300", .candidates = 3, .cand_mass = 0.80f, .temperature = 0.60f, .replies = 2,
     .line_depth = 3, .alt_depth = 1, .optimism = 0.30f, .satisfied = 0.03f, .prior = 0.03f,
     .blind = 0.25f, .material = 0.0f, .budget = 60},
};
const int HPROFILE_COUNT = sizeof(HPROFILES) / sizeof(HPROFILES[0]);

static uint64_t rng_state = 0x9E3779B97F4A7C15ull;

void hsearch_seed(uint64_t seed) { rng_state = seed * 0x9E3779B97F4A7C15ull + 1; }

static uint64_t rng(void) {
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 7;
    rng_state ^= rng_state << 17;
    return rng_state;
}

static float uniform(void) { return (float)((rng() >> 11) + 0.5) / 9007199254740992.0f; }

typedef struct {
    Position* pos;
    const HProfile* p;
    int me;
    int evals;
} Ctx;

static void evaluate(Ctx* c, HEval* e) {
    hnet_evaluate(c->pos, e);
    c->evals++;
}

// Value for "me" of a position with no legal moves or a draw by rule, or -1 if neither.
static float terminal(Ctx* c, const HEval* e, int ply) {
    if (e->count == 0) return in_check(c->pos) ? (c->pos->side == c->me ? 0.0f : 1.0f) : 0.5f;
    if (pos_is_draw(c->pos, ply)) return 0.5f;
    return -1;
}

// The position's value for the side to move as players of the band judge it, blended with a
// plain material count (each pawn of advantage is worth about 10% in winning chances).
static float judge(const Ctx* c, const HEval* e) {
    static const int VALUE[6] = {1, 3, 3, 5, 9, 0};
    int diff = 0;
    for (int pt = PAWN; pt < KING; ++pt)
        diff += VALUE[pt] * (popcount(pieces_of(c->pos, c->pos->side, pt)) - popcount(pieces_of(c->pos, c->pos->side ^ 1, pt)));
    float count = 1 / (1 + powf(10, -diff / 4.0f));
    return (1 - c->p->material) * e->value + c->p->material * count;
}

// Follows the line from the current position: each side plays its most likely move for
// `depth` plies (plus up to two to answer a capture). Returns the value for "me" at its end
// and appends the moves to line[].
static float follow(Ctx* c, int depth, int ply, Move* line, int* len) {
    Move played[40];
    int n = 0;
    float v;
    for (int d = 0;; ++d) {
        HEval e;
        evaluate(c, &e);
        float t = terminal(c, &e, ply + n);
        if (t >= 0) {
            v = t;
            break;
        }
        int capture_pending = n > 0 && move_is_capture(played[n - 1]) && d < depth + 2;
        if ((d >= depth && !capture_pending) || n >= 38) {
            float j = judge(c, &e);
            v = c->pos->side == c->me ? j : 1 - j;
            break;
        }
        Move m = e.moves[0];
        pos_make_move(c->pos, m);
        played[n++] = m;
        if (*len < 32) line[(*len)++] = m;
    }
    while (n > 0) pos_unmake_move(c->pos, played[--n]);
    return v;
}

// Does the player overlook this opponent move? Backward moves of pieces and long quiet
// slides are the ones that get missed.
static int overlooked(const Ctx* c, Move m) {
    if (c->p->blind <= 0) return 0;
    const Position* pos = c->pos;
    int from = move_from(m), to = move_to(m), type = piece_type(moved_piece(pos, m));
    int backward = type != PAWN && relative_rank(pos->side, to) < relative_rank(pos->side, from);
    int df = file_of(to) - file_of(from), dr = rank_of(to) - rank_of(from);
    int dist = (df < 0 ? -df : df) > (dr < 0 ? -dr : dr) ? (df < 0 ? -df : df) : (dr < 0 ? -dr : dr);
    int long_quiet = !move_is_capture(m) && (type == BISHOP || type == ROOK || type == QUEEN) && dist >= 4;
    return (backward || long_quiet) && uniform() < c->p->blind;
}

HResult hsearch_run(Position* pos, const HProfile* p) {
    Ctx c = {pos, p, pos->side, 0};
    HResult r;
    memset(&r, 0, sizeof(r));
    HEval root;
    evaluate(&c, &root);
    if (root.count == 0) return r;
    float v0 = root.value;

    // Candidates: the most likely moves, then shuffled a little (Gumbel noise on log p).
    int n = 0;
    float mass = 0, key[MAX_MOVES];
    int idx[MAX_MOVES];
    while (n < root.count && n < p->candidates && (n == 0 || mass < p->cand_mass)) {
        mass += root.prob[n];
        key[n] = logf(root.prob[n] + 1e-9f) - p->temperature * logf(-logf(uniform()));
        idx[n] = n;
        n++;
    }
    for (int i = 1; i < n; ++i)
        for (int j = i; j > 0 && key[idx[j]] > key[idx[j - 1]]; --j) {
            int t = idx[j];
            idx[j] = idx[j - 1];
            idx[j - 1] = t;
        }

    float best = -1e9f;
    for (int k = 0; k < n; ++k) {
        if (k > 0 && c.evals >= p->budget) break;
        int i = idx[k];
        Move a = root.moves[i];
        Move line[32];
        int len = 0;
        line[len++] = a;
        pos_make_move(pos, a);
        HEval after;
        evaluate(&c, &after);
        float score, t = terminal(&c, &after, 1);
        if (t >= 0) {
            score = t;
        } else {
            float worst = 2, sum = 0;
            int checked = 0;
            Move best_line[32];
            int best_len = 0;
            for (int j = 0; j < after.count && checked < p->replies; ++j) {
                Move b = after.moves[j];
                // Always at least one reply is seen: the last chance is never overlooked.
                if (overlooked(&c, b) && !(checked == 0 && j == after.count - 1)) continue;
                Move l[32];
                int ll = 0;
                l[ll++] = b;
                pos_make_move(pos, b);
                float v = follow(&c, checked == 0 ? p->line_depth : p->alt_depth, 2, l, &ll);
                pos_unmake_move(pos, b);
                if (v < worst) {
                    worst = v;
                    memcpy(best_line, l, sizeof(Move) * (size_t)ll);
                    best_len = ll;
                }
                sum += v;
                checked++;
            }
            if (!checked) {
                worst = sum = 1 - after.value;
                checked = 1;
            }
            score = (1 - p->optimism) * worst + p->optimism * (sum / checked);
            for (int j = 0; j < best_len && len < 32; ++j) line[len++] = best_line[j];
        }
        pos_unmake_move(pos, a);

        float total = score + p->prior * logf(root.prob[i] + 1e-9f);
        int good = score >= v0 + p->satisfied;  // looks good: play it
        if (total > best || good) {
            best = total;
            r.best = a;
            r.score = score;
            r.line_len = len;
            memcpy(r.line, line, sizeof(Move) * (size_t)len);
        }
        if (good) break;
    }
    r.evals = c.evals;
    return r;
}
