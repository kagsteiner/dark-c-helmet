#include "search.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "eval.h"
#include "movegen.h"
#include "tt.h"
#include "tune.h"
#include "util.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
typedef HANDLE ThreadHandle;
#else
#include <pthread.h>
typedef pthread_t ThreadHandle;
#endif

int g_move_overhead = 20;

#define HISTORY_MAX 16384

// Correction history: per pawn structure, how far the static eval tends to be from the search
// result. Stored in units of 1/CORR_GRAIN centipawn, indexed by side to move and pawn key.
#define CORR_SIZE 16384
#define CORR_GRAIN 256
#define CORR_LIMIT (CORR_GRAIN * 64)

// History indexed by [piece][to-square] of a follow-up move.
typedef int PieceToHistory[12][64];

typedef struct {
    int static_eval;
    Move move;
    int piece;              // piece that made `move`
    PieceToHistory* cont;   // continuation history for moves following `move`
    Move killers[2];
    Move excluded;      // move skipped by the singular-extension verification search
} StackEntry;

typedef struct SearchThread {
    Position pos;
    StackEntry stack[MAX_PLY + 8];
    Move pv[MAX_PLY + 1][MAX_PLY + 1];
    int pv_len[MAX_PLY + 1];
    long long nodes;
    int seldepth;
    int stop;
    int silent;
    int (*poll_stop)(void);

    long long start_ms;
    long long soft_ms;   // don't start a new iteration after this (scaled by stability)
    long long hard_ms;   // abort the search after this
    long long max_nodes;
    int use_time;

    Move root_best;
    int root_best_score;
    int root_depth;
    long long root_move_nodes[64 * 64];  // nodes spent below each root move (from * 64 + to)

    int id;              // 0 = main thread (time management, output)
    SearchResult result;

    // History tables survive between moves of the same game.
    int history[2][64][64];
    Move countermoves[12][64];
    PieceToHistory cont_history[12][64];  // [previous piece][previous to]
    int capture_history[12][64][6];       // [moving piece][to][captured piece type]
    int correction[2][CORR_SIZE];         // [side to move][pawn key]
} SearchThread;

static PieceToHistory cont_sentinel;  // used after null moves and at the root (never updated)
static int lmr_table[64][64];

// Static rather than heap: see the note on g_pos in uci.c. Untouched threads cost no memory.
#define MAX_THREADS 64
static SearchThread threads[MAX_THREADS];
static int thread_count = 1;
static volatile int stop_all;  // set by the main thread, read by helpers

void search_init(void) {
    for (int d = 1; d < 64; ++d)
        for (int m = 1; m < 64; ++m) lmr_table[d][m] = (int)(lmr_base / 100.0 + log((double)d) * log((double)m) / (lmr_div / 100.0));
}

void search_clear(void) {
    for (int i = 0; i < thread_count; ++i) {
        SearchThread* t = &threads[i];
        memset(t->history, 0, sizeof(t->history));
        memset(t->countermoves, 0, sizeof(t->countermoves));
        memset(t->cont_history, 0, sizeof(t->cont_history));
        memset(t->capture_history, 0, sizeof(t->capture_history));
        memset(t->correction, 0, sizeof(t->correction));
    }
}

void search_set_threads(int n) {
    if (n < 1) n = 1;
    if (n > MAX_THREADS) n = MAX_THREADS;
    thread_count = n;
    search_clear();
}

// ---------------------------------------------------------------------------
// Time and stop handling
// ---------------------------------------------------------------------------

static void check_stop(SearchThread* t) {
    if (t->id != 0) {
        if (stop_all) t->stop = 1;
        return;
    }
    if (t->max_nodes && t->nodes >= t->max_nodes) t->stop = 1;
    if ((t->nodes & 2047) != 0) return;
    if (t->use_time && now_ms() - t->start_ms >= t->hard_ms) t->stop = 1;
    if (!t->silent && t->poll_stop && t->poll_stop()) t->stop = 1;
}

static void init_time(SearchThread* t, const SearchLimits* lim, int side) {
    t->use_time = 0;
    t->soft_ms = t->hard_ms = 0;
    if (lim->infinite) return;
    if (lim->movetime >= 0) {
        t->use_time = 1;
        t->soft_ms = t->hard_ms = lim->movetime - g_move_overhead > 1 ? lim->movetime - g_move_overhead : 1;
        return;
    }
    if (lim->time[side] < 0) return;
    t->use_time = 1;
    long long avail = lim->time[side] - g_move_overhead;
    if (avail < 1) avail = 1;
    long long inc = lim->inc[side];
    long long soft;
    if (lim->movestogo > 0) soft = avail / (lim->movestogo + 1) + inc * 3 / 4;
    else soft = avail / 25 + inc * 3 / 4;
    long long hard = soft * 3;
    long long cap = avail * 3 / 4;
    if (hard > cap) hard = cap;
    if (soft > hard) soft = hard;
    if (soft < 1) soft = 1;
    if (hard < 1) hard = 1;
    t->soft_ms = soft;
    t->hard_ms = hard;
}

// ---------------------------------------------------------------------------
// Move ordering
// ---------------------------------------------------------------------------

enum {
    SCORE_TT = 1 << 30,
    SCORE_GOOD_NOISY = 1 << 28,
    SCORE_KILLER1 = (1 << 27) + 2,
    SCORE_KILLER2 = (1 << 27) + 1,
    SCORE_COUNTER = 1 << 27,
    SCORE_BAD_NOISY = -(1 << 28),
};

// Combined quiet-move history: butterfly + 1-ply and 2-ply continuation history.
static inline int quiet_history(SearchThread* t, const StackEntry* ss, int side, int piece, Move m) {
    int to = move_to(m);
    return t->history[side][move_from(m)][to] + (*ss[-1].cont)[piece][to] + (*ss[-2].cont)[piece][to];
}

// Type of the captured piece, or -1 for non-captures.
static inline int captured_type(const Position* pos, Move m) {
    if (!move_is_capture(m)) return -1;
    return move_flags(m) == FLAG_EP ? PAWN : piece_type(pos->board[move_to(m)]);
}

// Scores a full move list (used by quiescence search). With use_see == 0 captures are not
// split into winning and losing ones; the caller prunes losing captures itself.
static void score_moves(SearchThread* t, MoveList* list, Move tt_move, int ply, int use_see) {
    const Position* pos = &t->pos;
    const StackEntry* ss = &t->stack[ply + 4];
    Move counter = MOVE_NONE;
    if (ply > 0 && ss[-1].move != MOVE_NONE) counter = t->countermoves[ss[-1].piece][move_to(ss[-1].move)];

    for (int i = 0; i < list->count; ++i) {
        Move m = list->moves[i].move;
        int score;
        if (m == tt_move) {
            score = SCORE_TT;
        } else if (move_is_tactical(m)) {
            int victim = captured_type(pos, m);
            int value = victim >= 0 ? SEE_VALUE[victim] : 0;
            if (move_is_promo(m)) value += (move_promo_type(m) == QUEEN) ? SEE_VALUE[QUEEN] : -1000;
            int attacker = piece_type(pos->board[move_from(m)]);
            int good = move_is_promo(m) ? move_promo_type(m) == QUEEN : (!use_see || see_ge(pos, m, 0));
            // Victim value first; capture history breaks ties between similar captures.
            int hist = victim >= 0 ? t->capture_history[pos->board[move_from(m)]][move_to(m)][victim] / 16 : 0;
            score = (good ? SCORE_GOOD_NOISY : SCORE_BAD_NOISY) + value * 16 - attacker + hist;
        } else if (m == ss->killers[0]) {
            score = SCORE_KILLER1;
        } else if (m == ss->killers[1]) {
            score = SCORE_KILLER2;
        } else if (m == counter) {
            score = SCORE_COUNTER;
        } else {
            score = quiet_history(t, ss, pos->side, pos->board[move_from(m)], m);
        }
        list->moves[i].score = score;
    }
}

static Move pick_move(MoveList* list, int index) {
    int best = index;
    for (int i = index + 1; i < list->count; ++i)
        if (list->moves[i].score > list->moves[best].score) best = i;
    ScoredMove tmp = list->moves[index];
    list->moves[index] = list->moves[best];
    list->moves[best] = tmp;
    return list->moves[index].move;
}

// ---------------------------------------------------------------------------
// Staged move picker for the main search: moves are produced lazily, so a cutoff by the
// hash move or a good capture saves generating (and scoring) the quiet moves, and the
// static exchange evaluation is only computed for captures that are actually picked.
// ---------------------------------------------------------------------------

enum {
    STAGE_TT, STAGE_GEN_NOISY, STAGE_GOOD_NOISY, STAGE_KILLER1, STAGE_KILLER2, STAGE_COUNTER,
    STAGE_GEN_QUIET, STAGE_QUIET, STAGE_BAD_NOISY, STAGE_DONE
};

typedef struct {
    int stage;
    Move tt_move, killer1, killer2, counter;
    MoveList list;
    int index;
    Move bad[MAX_MOVES];  // losing captures, tried after the quiet moves
    int bad_count, bad_index;
} MovePicker;

static void picker_init(MovePicker* mp, SearchThread* t, Move tt_move, int ply) {
    const Position* pos = &t->pos;
    const StackEntry* ss = &t->stack[ply + 4];
    mp->stage = STAGE_TT;
    mp->tt_move = pos_is_pseudo_legal(pos, tt_move) ? tt_move : MOVE_NONE;
    mp->killer1 = ss->killers[0];
    mp->killer2 = ss->killers[1];
    mp->counter = (ply > 0 && ss[-1].move != MOVE_NONE) ? t->countermoves[ss[-1].piece][move_to(ss[-1].move)]
                                                         : MOVE_NONE;
    mp->index = 0;
    mp->bad_count = mp->bad_index = 0;
}

// A refutation move (killer / countermove) worth trying before the quiet moves are generated.
static inline int good_refutation(const Position* pos, const MovePicker* mp, Move m) {
    return m != MOVE_NONE && m != mp->tt_move && !move_is_tactical(m) && pos_is_pseudo_legal(pos, m);
}

static Move picker_next(MovePicker* mp, SearchThread* t, int ply, int skip_quiets) {
    const Position* pos = &t->pos;
    const StackEntry* ss = &t->stack[ply + 4];
    for (;;) {
        switch (mp->stage) {
            case STAGE_TT:
                mp->stage = STAGE_GEN_NOISY;
                if (mp->tt_move != MOVE_NONE) return mp->tt_move;
                break;

            case STAGE_GEN_NOISY:
                generate_moves(pos, &mp->list, GEN_NOISY);
                for (int i = 0; i < mp->list.count; ++i) {
                    Move m = mp->list.moves[i].move;
                    int victim = captured_type(pos, m);
                    int value = (victim >= 0 ? SEE_VALUE[victim] : 0) + (move_is_promo(m) ? SEE_VALUE[QUEEN] : 0);
                    int hist = victim >= 0 ? t->capture_history[pos->board[move_from(m)]][move_to(m)][victim] / 16 : 0;
                    mp->list.moves[i].score = value * 16 - piece_type(pos->board[move_from(m)]) + hist;
                }
                mp->index = 0;
                mp->stage = STAGE_GOOD_NOISY;
                break;

            case STAGE_GOOD_NOISY:
                while (mp->index < mp->list.count) {
                    Move m = pick_move(&mp->list, mp->index++);
                    if (m == mp->tt_move) continue;
                    if (!move_is_promo(m) && !see_ge(pos, m, 0)) {  // losing capture: postpone
                        mp->bad[mp->bad_count++] = m;
                        continue;
                    }
                    return m;
                }
                mp->stage = STAGE_KILLER1;
                break;

            case STAGE_KILLER1:
                mp->stage = STAGE_KILLER2;
                if (!skip_quiets && good_refutation(pos, mp, mp->killer1)) return mp->killer1;
                break;

            case STAGE_KILLER2:
                mp->stage = STAGE_COUNTER;
                if (!skip_quiets && mp->killer2 != mp->killer1 && good_refutation(pos, mp, mp->killer2))
                    return mp->killer2;
                break;

            case STAGE_COUNTER:
                mp->stage = STAGE_GEN_QUIET;
                if (!skip_quiets && mp->counter != mp->killer1 && mp->counter != mp->killer2 &&
                    good_refutation(pos, mp, mp->counter))
                    return mp->counter;
                break;

            case STAGE_GEN_QUIET:
                if (skip_quiets) {
                    mp->stage = STAGE_BAD_NOISY;
                    break;
                }
                generate_moves(pos, &mp->list, GEN_QUIET);
                for (int i = 0; i < mp->list.count; ++i) {
                    Move m = mp->list.moves[i].move;
                    mp->list.moves[i].score = quiet_history(t, ss, pos->side, pos->board[move_from(m)], m);
                }
                mp->index = 0;
                mp->stage = STAGE_QUIET;
                break;

            case STAGE_QUIET:
                while (!skip_quiets && mp->index < mp->list.count) {
                    Move m = pick_move(&mp->list, mp->index++);
                    if (m == mp->tt_move || m == mp->killer1 || m == mp->killer2 || m == mp->counter) continue;
                    return m;
                }
                mp->stage = STAGE_BAD_NOISY;
                break;

            case STAGE_BAD_NOISY:
                if (mp->bad_index < mp->bad_count) return mp->bad[mp->bad_index++];
                mp->stage = STAGE_DONE;
                break;

            default:
                return MOVE_NONE;
        }
    }
}

static inline void history_update(int* entry, int bonus) {
    *entry += bonus - *entry * abs(bonus) / HISTORY_MAX;
}

static void update_quiet_heuristics(SearchThread* t, int ply, int depth, Move best, const Move* quiets, int quiet_count) {
    StackEntry* ss = &t->stack[ply + 4];
    int side = t->pos.side;
    int bonus = depth * depth * hist_bonus_mult;
    if (bonus > hist_bonus_max) bonus = hist_bonus_max;

    if (ss->killers[0] != best) {
        ss->killers[1] = ss->killers[0];
        ss->killers[0] = best;
    }
    if (ply > 0 && ss[-1].move != MOVE_NONE) t->countermoves[ss[-1].piece][move_to(ss[-1].move)] = best;

    const Position* pos = &t->pos;
    for (int i = -1; i < quiet_count; ++i) {
        Move m = i < 0 ? best : quiets[i];
        int b = i < 0 ? bonus : -bonus;
        int pc = pos->board[move_from(m)], to = move_to(m);
        history_update(&t->history[side][move_from(m)][to], b);
        history_update(&(*ss[-1].cont)[pc][to], b);
        history_update(&(*ss[-2].cont)[pc][to], b);
    }
}

// Reward the capture that caused a cutoff (if any) and punish the captures tried before it.
static void update_capture_history(SearchThread* t, int depth, Move best, const Move* captures, int capture_count) {
    const Position* pos = &t->pos;
    int bonus = depth * depth * hist_bonus_mult;
    if (bonus > hist_bonus_max) bonus = hist_bonus_max;
    int victim = captured_type(pos, best);
    if (victim >= 0) history_update(&t->capture_history[pos->board[move_from(best)]][move_to(best)][victim], bonus);
    for (int i = 0; i < capture_count; ++i) {
        Move m = captures[i];
        history_update(&t->capture_history[pos->board[move_from(m)]][move_to(m)][captured_type(pos, m)], -bonus);
    }
}

static inline int* correction_entry(SearchThread* t) {
    return &t->correction[t->pos.side][t->pos.st->pawn_key & (CORR_SIZE - 1)];
}

// Static evaluation adjusted by the learned correction for this pawn structure.
static inline int corrected_eval(SearchThread* t, int raw) {
    int v = raw + *correction_entry(t) / CORR_GRAIN;
    return v >= VALUE_MATE_IN_MAX ? VALUE_MATE_IN_MAX - 1 : v <= -VALUE_MATE_IN_MAX ? -VALUE_MATE_IN_MAX + 1 : v;
}

// Move the correction towards (search result - static eval), weighted by depth.
static void update_correction(SearchThread* t, int depth, int diff) {
    int* e = correction_entry(t);
    int weight = depth + 1 < 16 ? depth + 1 : 16;
    int v = (*e * (256 - weight) + diff * CORR_GRAIN * weight) / 256;
    *e = v > CORR_LIMIT ? CORR_LIMIT : v < -CORR_LIMIT ? -CORR_LIMIT : v;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

static int qsearch(SearchThread* t, int alpha, int beta, int ply) {
    Position* pos = &t->pos;
    int pv_node = beta - alpha > 1;
    t->pv_len[ply] = 0;

    t->nodes++;
    check_stop(t);
    if (t->stop) return 0;
    if (ply > t->seldepth) t->seldepth = ply;
    if (ply >= MAX_PLY - 1) return in_check(pos) ? 0 : evaluate(pos);

    int hit;
    TTEntry* tte = tt_probe(pos->st->key, &hit);
    int tt_score = hit ? score_from_tt(tte->score, ply) : VALUE_NONE;
    Move tt_move = hit ? tte->move : MOVE_NONE;
    if (!pv_node && tt_score != VALUE_NONE &&
        (tt_bound(tte) & (tt_score >= beta ? BOUND_LOWER : BOUND_UPPER)))
        return tt_score;

    int checked = in_check(pos);
    int best, raw_eval = VALUE_NONE, futility_base = -VALUE_INF;
    MoveList list;

    if (checked) {
        best = -VALUE_INF;
        generate_moves(pos, &list, GEN_ALL);
    } else {
        raw_eval = (hit && tte->eval != VALUE_NONE) ? tte->eval : evaluate(pos);
        best = corrected_eval(t, raw_eval);
        if (tt_score != VALUE_NONE && (tt_bound(tte) & (tt_score > best ? BOUND_LOWER : BOUND_UPPER)))
            best = tt_score;
        if (best >= beta) {
            if (!hit) tt_store(tte, pos->st->key, 0, score_to_tt(best, ply), raw_eval, BOUND_LOWER, MOVE_NONE);
            return best;
        }
        if (best > alpha) alpha = best;
        futility_base = best + qs_fut_margin;
        generate_moves(pos, &list, GEN_NOISY);
    }
    score_moves(t, &list, tt_move, ply, checked);

    Move best_move = MOVE_NONE;
    int legal = 0;
    for (int i = 0; i < list.count; ++i) {
        Move m = pick_move(&list, i);
        if (!pos_is_legal(pos, m)) continue;
        legal++;

        if (!checked) {
            if (!see_ge(pos, m, 0)) continue;
            if (move_is_capture(m) && !move_is_promo(m)) {
                int victim = move_flags(m) == FLAG_EP ? PAWN : piece_type(pos->board[move_to(m)]);
                int futility = futility_base + SEE_VALUE[victim];
                if (futility <= alpha) {
                    if (futility > best) best = futility;
                    continue;
                }
            }
        }

        StackEntry* ss = &t->stack[ply + 4];
        ss->move = m;
        ss->piece = moved_piece(pos, m);
        ss->cont = &t->cont_history[ss->piece][move_to(m)];
        pos_make_move(pos, m);
        int score = -qsearch(t, -beta, -alpha, ply + 1);
        pos_unmake_move(pos, m);
        if (t->stop) return 0;

        if (score > best) {
            best = score;
            if (score > alpha) {
                best_move = m;
                alpha = score;
                if (score >= beta) break;
            }
        }
    }

    if (checked && legal == 0) return -VALUE_MATE + ply;

    int bound = best >= beta ? BOUND_LOWER : BOUND_UPPER;
    tt_store(tte, pos->st->key, 0, score_to_tt(best, ply), raw_eval, bound, best_move);
    return best;
}

static int search(SearchThread* t, int alpha, int beta, int depth, int ply) {
    Position* pos = &t->pos;
    int pv_node = beta - alpha > 1;
    int root = ply == 0;
    StackEntry* ss = &t->stack[ply + 4];
    int checked = in_check(pos);
    Move excluded = ss->excluded;

    // Check extension
    if (checked && depth < MAX_PLY) depth++;
    if (depth <= 0) return qsearch(t, alpha, beta, ply);

    t->pv_len[ply] = 0;
    t->nodes++;
    check_stop(t);
    if (t->stop) return 0;
    if (ply > t->seldepth) t->seldepth = ply;

    if (!root) {
        if (pos_is_draw(pos, ply)) return VALUE_DRAW;
        if (ply >= MAX_PLY - 1) return checked ? 0 : evaluate(pos);
        // Mate distance pruning
        int mated = -VALUE_MATE + ply;
        int mating = VALUE_MATE - ply - 1;
        if (alpha < mated) alpha = mated;
        if (beta > mating) beta = mating;
        if (alpha >= beta) return alpha;
    }

    int hit;
    uint64_t key = pos->st->key;
    TTEntry* tte = tt_probe(key, &hit);
    int tt_score = hit ? score_from_tt(tte->score, ply) : VALUE_NONE;
    Move tt_move = hit ? tte->move : MOVE_NONE;
    if (root && t->pv_len[0] == 0 && t->root_best != MOVE_NONE) tt_move = t->root_best;

    if (!pv_node && !excluded && hit && tt_depth(tte) >= depth && tt_score != VALUE_NONE &&
        (tt_bound(tte) & (tt_score >= beta ? BOUND_LOWER : BOUND_UPPER)))
        return tt_score;

    // Static evaluation
    int raw_eval = VALUE_NONE, eval = VALUE_NONE, improving = 0;
    if (checked) {
        ss->static_eval = VALUE_NONE;
    } else {
        raw_eval = (hit && tte->eval != VALUE_NONE) ? tte->eval : evaluate(pos);
        ss->static_eval = eval = corrected_eval(t, raw_eval);
        if (tt_score != VALUE_NONE && (tt_bound(tte) & (tt_score > eval ? BOUND_LOWER : BOUND_UPPER)))
            eval = tt_score;
        if (ply >= 2 && ss[-2].static_eval != VALUE_NONE) improving = ss->static_eval > ss[-2].static_eval;
        else if (ply >= 4 && ss[-4].static_eval != VALUE_NONE) improving = ss->static_eval > ss[-4].static_eval;
    }

    ss[1].killers[0] = ss[1].killers[1] = MOVE_NONE;

    if (!pv_node && !checked && !excluded) {
        // Reverse futility pruning
        if (depth <= rfp_depth && eval - rfp_margin * (depth - improving) >= beta && eval < VALUE_MATE_IN_MAX) return eval;

        // Razoring
        if (depth <= 3 && eval + razor_margin * depth <= alpha) {
            int score = qsearch(t, alpha, beta, ply);
            if (score <= alpha) return score;
        }

        // Null move pruning
        if (depth >= 3 && eval >= beta && ss->static_eval >= beta && ss[-1].move != MOVE_NONE &&
            non_pawn_material(pos, pos->side) && beta > -VALUE_MATE_IN_MAX) {
            int r = nmp_base + depth / nmp_depth_div + ((eval - beta) / nmp_eval_div < 3 ? (eval - beta) / nmp_eval_div : 3);
            ss->move = MOVE_NONE;
            ss->piece = NO_PIECE;
            ss->cont = &cont_sentinel;
            pos_make_null(pos);
            int score = -search(t, -beta, -beta + 1, depth - r, ply + 1);
            pos_unmake_null(pos);
            if (t->stop) return 0;
            if (score >= beta) return score >= VALUE_MATE_IN_MAX ? beta : score;
        }
    }

    // Internal iterative reduction: without a hash move, this node is probably less important.
    if (depth >= iir_depth && tt_move == MOVE_NONE && !root) depth--;

    MovePicker mp;
    picker_init(&mp, t, tt_move, ply);

    int best = -VALUE_INF;
    Move best_move = MOVE_NONE;
    int alpha_orig = alpha;
    int legal = 0, skip_quiets = 0;
    Move quiets[64], captures[32];
    int quiet_count = 0, capture_count = 0;

    Move m;
    while ((m = picker_next(&mp, t, ply, skip_quiets)) != MOVE_NONE) {
        if (m == excluded || !pos_is_legal(pos, m)) continue;
        legal++;
        int quiet = !move_is_tactical(m);
        if (quiet && skip_quiets) continue;

        // Shallow-depth pruning, once a real score is secured
        if (!root && best > -VALUE_MATE_IN_MAX && non_pawn_material(pos, pos->side)) {
            if (quiet) {
                if (depth <= 8 && legal > (lmp_base + depth * depth) / (2 - improving)) {
                    skip_quiets = 1;
                    continue;
                }
                if (!checked && depth <= 8 && ss->static_eval != VALUE_NONE &&
                    ss->static_eval + fut_base + fut_mult * depth <= alpha) {
                    skip_quiets = 1;
                    continue;
                }
                if (depth <= 8 && !see_ge(pos, m, -see_quiet * depth)) continue;
            } else {
                if (depth <= 8 && !see_ge(pos, m, -see_noisy * depth)) continue;
            }
        }

        // Singular extension: if every alternative to the hash move fails well below its
        // score, the hash move is forced and deserves an extra ply.
        int extension = 0;
        if (!root && m == tt_move && !excluded && depth >= se_depth && hit && tt_depth(tte) >= depth - 3 &&
            (tt_bound(tte) & BOUND_LOWER) && abs(tt_score) < VALUE_MATE_IN_MAX && ply < 2 * t->root_depth) {
            int singular_beta = tt_score - se_margin * depth / 16;
            ss->excluded = m;
            int s = search(t, singular_beta - 1, singular_beta, (depth - 1) / 2, ply);
            ss->excluded = MOVE_NONE;
            if (t->stop) return 0;
            if (s < singular_beta) extension = 1;
            else if (singular_beta >= beta) return singular_beta;  // multi-cut: several moves beat beta
            else if (tt_score >= beta) extension = -1;
        }

        int hist = quiet ? quiet_history(t, ss, pos->side, pos->board[move_from(m)], m) : 0;

        ss->move = m;
        ss->piece = moved_piece(pos, m);
        ss->cont = &t->cont_history[ss->piece][move_to(m)];
        long long nodes_before = t->nodes;
        pos_make_move(pos, m);
        tt_prefetch(pos->st->key);
        int gives_check = in_check(pos);
        int new_depth = depth - 1 + extension;
        int score;

        if (depth >= 3 && legal > 1 + pv_node && quiet) {
            int r = lmr_table[depth < 64 ? depth : 63][legal < 64 ? legal : 63];
            r -= pv_node;
            r += !improving;
            r -= gives_check;
            r -= (m == ss->killers[0] || m == ss->killers[1]);
            r -= hist / lmr_hist_div;
            if (r < 0) r = 0;
            if (r > new_depth - 1) r = new_depth - 1;
            score = -search(t, -alpha - 1, -alpha, new_depth - r, ply + 1);
            if (score > alpha && r > 0) score = -search(t, -alpha - 1, -alpha, new_depth, ply + 1);
        } else if (!pv_node || legal > 1) {
            score = -search(t, -alpha - 1, -alpha, new_depth, ply + 1);
        } else {
            score = alpha + 1;  // force the full-window search below for the first PV move
        }
        if (pv_node && (legal == 1 || score > alpha)) score = -search(t, -beta, -alpha, new_depth, ply + 1);

        pos_unmake_move(pos, m);
        if (root) t->root_move_nodes[move_from(m) * 64 + move_to(m)] += t->nodes - nodes_before;
        if (t->stop) return 0;

        if (score > best) {
            best = score;
            if (score > alpha) {
                best_move = m;
                alpha = score;
                if (pv_node) {
                    t->pv[ply][0] = m;
                    for (int j = 0; j < t->pv_len[ply + 1]; ++j) t->pv[ply][j + 1] = t->pv[ply + 1][j];
                    t->pv_len[ply] = t->pv_len[ply + 1] + 1;
                }
                if (root) {
                    t->root_best = m;
                    t->root_best_score = score;
                }
                if (score >= beta) {
                    if (quiet) update_quiet_heuristics(t, ply, depth, m, quiets, quiet_count);
                    update_capture_history(t, depth, m, captures, capture_count);
                    break;
                }
            }
        }
        if (quiet && m != best_move && quiet_count < 64) quiets[quiet_count++] = m;
        if (move_is_capture(m) && m != best_move && capture_count < 32) captures[capture_count++] = m;
    }

    if (legal == 0) return excluded ? alpha : checked ? -VALUE_MATE + ply : VALUE_DRAW;

    int bound = best >= beta ? BOUND_LOWER : (best > alpha_orig ? BOUND_EXACT : BOUND_UPPER);
    if (!excluded) tt_store(tte, key, depth, score_to_tt(best, ply), raw_eval, bound, best_move);

    // Learn the eval correction from quiet positions whose score is trustworthy relative to
    // the static eval (a fail-high above it, a fail-low below it, or an exact score).
    if (!checked && !excluded && (best_move == MOVE_NONE || !move_is_tactical(best_move)) &&
        abs(best) < VALUE_MATE_IN_MAX && ss->static_eval != VALUE_NONE &&
        !(bound == BOUND_LOWER && best <= ss->static_eval) && !(bound == BOUND_UPPER && best >= ss->static_eval))
        update_correction(t, depth, best - ss->static_eval);
    return best;
}

// ---------------------------------------------------------------------------
// Iterative deepening
// ---------------------------------------------------------------------------

// Prints the search result; the PV always starts with `best` (the move that will be played).
static long long total_nodes(void) {
    long long n = 0;
    for (int i = 0; i < thread_count; ++i) n += threads[i].nodes;
    return n;
}

static void print_info(SearchThread* t, int depth, int score, Move best) {
    long long elapsed = now_ms() - t->start_ms;
    long long nodes = total_nodes();
    long long nps = nodes * 1000 / (elapsed > 0 ? elapsed : 1);
    printf("info depth %d seldepth %d ", depth, t->seldepth);
    if (score >= VALUE_MATE_IN_MAX) printf("score mate %d ", (VALUE_MATE - score + 1) / 2);
    else if (score <= -VALUE_MATE_IN_MAX) printf("score mate -%d ", (VALUE_MATE + score) / 2);
    else printf("score cp %d ", score);
    printf("nodes %lld nps %lld hashfull %d time %lld pv", nodes, nps, tt_hashfull(), elapsed);
    char buf[6];
    if (t->pv_len[0] > 0 && t->pv[0][0] == best) {
        for (int i = 0; i < t->pv_len[0]; ++i) {
            move_to_str(t->pv[0][i], buf);
            printf(" %s", buf);
        }
    } else {
        move_to_str(best, buf);
        printf(" %s", buf);
    }
    printf("\n");
    fflush(stdout);
}

// ---------------------------------------------------------------------------
// Iterative deepening (every thread runs this; only the main thread manages time and output)
// ---------------------------------------------------------------------------

static void iterative_deepening(SearchThread* t, int max_depth) {
    Move prev_best = MOVE_NONE;
    int stability = 0;
    int score = 0, prev_score = VALUE_NONE;
    int main = t->id == 0;
    SearchResult* result = &t->result;

    for (int depth = 1; depth <= max_depth; ++depth) {
        t->seldepth = 0;
        t->root_depth = depth;
        int delta = asp_delta;
        int alpha = -VALUE_INF, beta = VALUE_INF;
        if (depth >= 4) {
            alpha = score - delta > -VALUE_INF ? score - delta : -VALUE_INF;
            beta = score + delta < VALUE_INF ? score + delta : VALUE_INF;
        }
        // Aspiration windows: widen on fail-low/high until the score fits.
        for (;;) {
            int s = search(t, alpha, beta, depth, 0);
            if (t->stop) break;
            if (s <= alpha) {
                beta = (alpha + beta) / 2;
                alpha = s - delta > -VALUE_INF ? s - delta : -VALUE_INF;
            } else if (s >= beta) {
                beta = s + delta < VALUE_INF ? s + delta : VALUE_INF;
            } else {
                score = s;
                break;
            }
            delta += delta / 2;
        }

        // A move that raised alpha at the root was fully searched, so it is usable even if
        // this iteration was interrupted.
        if (t->root_best != MOVE_NONE) result->best_move = t->root_best;
        if (t->stop) {
            // The interrupted iteration found a better move: report it so the last info line
            // matches the bestmove sent to the GUI.
            if (main && !t->silent && result->best_move != prev_best && prev_best != MOVE_NONE)
                print_info(t, depth, t->root_best_score, result->best_move);
            break;
        }

        result->score = score;
        result->depth = depth;
        if (!main) continue;
        if (!t->silent) print_info(t, depth, score, result->best_move);

        if (result->best_move == prev_best) stability++;
        else stability = 0;
        prev_best = result->best_move;

        if (t->use_time) {
            // Soft limit, scaled by three signals:
            //  - stability: the best move has not changed for several iterations -> less time
            //  - effort: share of nodes spent on the best move; a clear favourite -> less time
            //  - score trend: the score dropped since the last iteration -> more time
            static const double stability_scale[5] = {2.5, 1.2, 0.9, 0.8, 0.75};
            double scale = stability_scale[stability < 4 ? stability : 4];
            if (depth >= 6 && t->nodes > 0) {
                Move b = result->best_move;
                double best_share = (double)t->root_move_nodes[move_from(b) * 64 + move_to(b)] / (double)t->nodes;
                scale *= (1.5 - best_share) * 1.35;
            }
            if (prev_score != VALUE_NONE && abs(score) < VALUE_MATE_IN_MAX) {
                double trend = 1.0 + (prev_score - score) * 0.01;
                scale *= trend < 0.75 ? 0.75 : trend > 1.5 ? 1.5 : trend;
            }
            long long elapsed = now_ms() - t->start_ms;
            if (elapsed >= (long long)(t->soft_ms * scale)) break;
        }
        prev_score = score;
    }
}

static int helper_max_depth;

#ifdef _WIN32
static DWORD WINAPI helper_main(LPVOID arg) {
    iterative_deepening((SearchThread*)arg, helper_max_depth);
    return 0;
}
#else
static void* helper_main(void* arg) {
    iterative_deepening((SearchThread*)arg, helper_max_depth);
    return NULL;
}
#endif

static void thread_start(ThreadHandle* h, SearchThread* t) {
    // Deep recursion needs more than the default secondary-thread stack (512 KB on macOS).
#ifdef _WIN32
    *h = CreateThread(NULL, 8 << 20, helper_main, t, 0, NULL);
#else
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 8 << 20);
    pthread_create(h, &attr, helper_main, t);
    pthread_attr_destroy(&attr);
#endif
}

static void thread_join(ThreadHandle h) {
#ifdef _WIN32
    WaitForSingleObject(h, INFINITE);
    CloseHandle(h);
#else
    pthread_join(h, NULL);
#endif
}

SearchResult search_run(const Position* pos, const SearchLimits* limits, int silent, int (*poll_stop)(void)) {
    long long start = now_ms();
    stop_all = 0;
    tt_new_search();

    for (int i = 0; i < thread_count; ++i) {
        SearchThread* t = &threads[i];
        // Copy the position including its state history (needed for repetition detection).
        memcpy(&t->pos, pos, sizeof(Position));
        t->pos.st = t->pos.states + (pos->st - pos->states);
        memset(t->stack, 0, sizeof(t->stack));
        for (int j = 0; j < MAX_PLY + 8; ++j) {
            t->stack[j].static_eval = VALUE_NONE;
            t->stack[j].cont = &cont_sentinel;
        }
        t->id = i;
        t->nodes = 0;
        t->seldepth = 0;
        t->stop = 0;
        t->silent = silent;
        t->poll_stop = poll_stop;
        t->start_ms = start;
        t->max_nodes = limits->nodes;
        t->root_best = MOVE_NONE;
        t->root_best_score = 0;
        t->use_time = 0;
        memset(t->root_move_nodes, 0, sizeof(t->root_move_nodes));
        memset(&t->result, 0, sizeof(t->result));
    }
    SearchThread* main_thread = &threads[0];
    init_time(main_thread, limits, pos->side);

    MoveList legal_moves;
    generate_legal(&main_thread->pos, &legal_moves);
    if (legal_moves.count == 0) return main_thread->result;
    for (int i = 0; i < thread_count; ++i) threads[i].result.best_move = legal_moves.moves[0].move;

    int max_depth = limits->depth > 0 ? limits->depth : MAX_PLY - 8;
    helper_max_depth = MAX_PLY - 8;  // helpers run until the main thread stops them

    ThreadHandle handles[MAX_THREADS];
    for (int i = 1; i < thread_count; ++i) thread_start(&handles[i], &threads[i]);
    iterative_deepening(main_thread, max_depth);
    stop_all = 1;
    for (int i = 1; i < thread_count; ++i) thread_join(handles[i]);

    SearchResult result = main_thread->result;
    result.nodes = total_nodes();
    return result;
}
