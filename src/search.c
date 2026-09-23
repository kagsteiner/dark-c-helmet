#include "search.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "eval.h"
#include "movegen.h"
#include "tt.h"
#include "util.h"

int g_move_overhead = 20;

#define HISTORY_MAX 16384

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

typedef struct {
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
} SearchState;

// History tables survive between moves of the same game.
static int history[2][64][64];
static Move countermoves[12][64];
static PieceToHistory cont_history[12][64];  // [previous piece][previous to]
static PieceToHistory cont_sentinel;         // used after null moves and at the root
static int lmr_table[64][64];

static SearchState S;

void search_init(void) {
    for (int d = 1; d < 64; ++d)
        for (int m = 1; m < 64; ++m) lmr_table[d][m] = (int)(0.75 + log((double)d) * log((double)m) / 2.25);
}

void search_clear(void) {
    memset(history, 0, sizeof(history));
    memset(countermoves, 0, sizeof(countermoves));
    memset(cont_history, 0, sizeof(cont_history));
}

// ---------------------------------------------------------------------------
// Time and stop handling
// ---------------------------------------------------------------------------

static void check_stop(void) {
    if (S.max_nodes && S.nodes >= S.max_nodes) S.stop = 1;
    if ((S.nodes & 2047) != 0) return;
    if (S.use_time && now_ms() - S.start_ms >= S.hard_ms) S.stop = 1;
    if (!S.silent && S.poll_stop && S.poll_stop()) S.stop = 1;
}

static void init_time(const SearchLimits* lim, int side) {
    S.use_time = 0;
    S.soft_ms = S.hard_ms = 0;
    if (lim->infinite) return;
    if (lim->movetime >= 0) {
        S.use_time = 1;
        S.soft_ms = S.hard_ms = lim->movetime - g_move_overhead > 1 ? lim->movetime - g_move_overhead : 1;
        return;
    }
    if (lim->time[side] < 0) return;
    S.use_time = 1;
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
    S.soft_ms = soft;
    S.hard_ms = hard;
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
static inline int quiet_history(const StackEntry* ss, int side, int piece, Move m) {
    int to = move_to(m);
    return history[side][move_from(m)][to] + (*ss[-1].cont)[piece][to] + (*ss[-2].cont)[piece][to];
}

static void score_moves(MoveList* list, Move tt_move, int ply) {
    const Position* pos = &S.pos;
    const StackEntry* ss = &S.stack[ply + 4];
    Move counter = MOVE_NONE;
    if (ply > 0 && ss[-1].move != MOVE_NONE) counter = countermoves[ss[-1].piece][move_to(ss[-1].move)];

    for (int i = 0; i < list->count; ++i) {
        Move m = list->moves[i].move;
        int score;
        if (m == tt_move) {
            score = SCORE_TT;
        } else if (move_is_tactical(m)) {
            int victim = move_is_capture(m) ? (move_flags(m) == FLAG_EP ? PAWN : piece_type(pos->board[move_to(m)])) : -1;
            int value = victim >= 0 ? SEE_VALUE[victim] : 0;
            if (move_is_promo(m)) value += (move_promo_type(m) == QUEEN) ? SEE_VALUE[QUEEN] : -1000;
            int attacker = piece_type(pos->board[move_from(m)]);
            int good = move_is_promo(m) ? move_promo_type(m) == QUEEN : see_ge(pos, m, 0);
            score = (good ? SCORE_GOOD_NOISY : SCORE_BAD_NOISY) + value * 16 - attacker;
        } else if (m == ss->killers[0]) {
            score = SCORE_KILLER1;
        } else if (m == ss->killers[1]) {
            score = SCORE_KILLER2;
        } else if (m == counter) {
            score = SCORE_COUNTER;
        } else {
            score = quiet_history(ss, pos->side, pos->board[move_from(m)], m);
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

static inline void history_update(int* entry, int bonus) {
    *entry += bonus - *entry * abs(bonus) / HISTORY_MAX;
}

static void update_quiet_heuristics(int ply, int depth, Move best, const Move* quiets, int quiet_count) {
    StackEntry* ss = &S.stack[ply + 4];
    int side = S.pos.side;
    int bonus = depth * depth * 16;
    if (bonus > 1600) bonus = 1600;

    if (ss->killers[0] != best) {
        ss->killers[1] = ss->killers[0];
        ss->killers[0] = best;
    }
    if (ply > 0 && ss[-1].move != MOVE_NONE) countermoves[ss[-1].piece][move_to(ss[-1].move)] = best;

    const Position* pos = &S.pos;
    for (int i = -1; i < quiet_count; ++i) {
        Move m = i < 0 ? best : quiets[i];
        int b = i < 0 ? bonus : -bonus;
        int pc = pos->board[move_from(m)], to = move_to(m);
        history_update(&history[side][move_from(m)][to], b);
        history_update(&(*ss[-1].cont)[pc][to], b);
        history_update(&(*ss[-2].cont)[pc][to], b);
    }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

static int qsearch(int alpha, int beta, int ply) {
    Position* pos = &S.pos;
    int pv_node = beta - alpha > 1;
    S.pv_len[ply] = 0;

    S.nodes++;
    check_stop();
    if (S.stop) return 0;
    if (ply > S.seldepth) S.seldepth = ply;
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
        best = raw_eval;
        if (tt_score != VALUE_NONE && (tt_bound(tte) & (tt_score > best ? BOUND_LOWER : BOUND_UPPER)))
            best = tt_score;
        if (best >= beta) {
            if (!hit) tt_store(tte, pos->st->key, 0, score_to_tt(best, ply), raw_eval, BOUND_LOWER, MOVE_NONE);
            return best;
        }
        if (best > alpha) alpha = best;
        futility_base = best + 150;
        generate_moves(pos, &list, GEN_NOISY);
    }
    score_moves(&list, tt_move, ply);

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

        StackEntry* ss = &S.stack[ply + 4];
        ss->move = m;
        ss->piece = moved_piece(pos, m);
        ss->cont = &cont_history[ss->piece][move_to(m)];
        pos_make_move(pos, m);
        int score = -qsearch(-beta, -alpha, ply + 1);
        pos_unmake_move(pos, m);
        if (S.stop) return 0;

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

static int search(int alpha, int beta, int depth, int ply) {
    Position* pos = &S.pos;
    int pv_node = beta - alpha > 1;
    int root = ply == 0;
    StackEntry* ss = &S.stack[ply + 4];
    int checked = in_check(pos);
    Move excluded = ss->excluded;

    // Check extension
    if (checked && depth < MAX_PLY) depth++;
    if (depth <= 0) return qsearch(alpha, beta, ply);

    S.pv_len[ply] = 0;
    S.nodes++;
    check_stop();
    if (S.stop) return 0;
    if (ply > S.seldepth) S.seldepth = ply;

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
    if (root && S.pv_len[0] == 0 && S.root_best != MOVE_NONE) tt_move = S.root_best;

    if (!pv_node && !excluded && hit && tt_depth(tte) >= depth && tt_score != VALUE_NONE &&
        (tt_bound(tte) & (tt_score >= beta ? BOUND_LOWER : BOUND_UPPER)))
        return tt_score;

    // Static evaluation
    int raw_eval = VALUE_NONE, eval = VALUE_NONE, improving = 0;
    if (checked) {
        ss->static_eval = VALUE_NONE;
    } else {
        raw_eval = (hit && tte->eval != VALUE_NONE) ? tte->eval : evaluate(pos);
        ss->static_eval = eval = raw_eval;
        if (tt_score != VALUE_NONE && (tt_bound(tte) & (tt_score > eval ? BOUND_LOWER : BOUND_UPPER)))
            eval = tt_score;
        if (ply >= 2 && ss[-2].static_eval != VALUE_NONE) improving = ss->static_eval > ss[-2].static_eval;
        else if (ply >= 4 && ss[-4].static_eval != VALUE_NONE) improving = ss->static_eval > ss[-4].static_eval;
    }

    ss[1].killers[0] = ss[1].killers[1] = MOVE_NONE;

    if (!pv_node && !checked && !excluded) {
        // Reverse futility pruning
        if (depth <= 8 && eval - 80 * (depth - improving) >= beta && eval < VALUE_MATE_IN_MAX) return eval;

        // Razoring
        if (depth <= 3 && eval + 250 * depth <= alpha) {
            int score = qsearch(alpha, beta, ply);
            if (score <= alpha) return score;
        }

        // Null move pruning
        if (depth >= 3 && eval >= beta && ss->static_eval >= beta && ss[-1].move != MOVE_NONE &&
            non_pawn_material(pos, pos->side) && beta > -VALUE_MATE_IN_MAX) {
            int r = 3 + depth / 3 + ((eval - beta) / 200 < 3 ? (eval - beta) / 200 : 3);
            ss->move = MOVE_NONE;
            ss->piece = NO_PIECE;
            ss->cont = &cont_sentinel;
            pos_make_null(pos);
            int score = -search(-beta, -beta + 1, depth - r, ply + 1);
            pos_unmake_null(pos);
            if (S.stop) return 0;
            if (score >= beta) return score >= VALUE_MATE_IN_MAX ? beta : score;
        }
    }

    // Internal iterative reduction: without a hash move, this node is probably less important.
    if (depth >= 4 && tt_move == MOVE_NONE && !root) depth--;

    MoveList list;
    generate_moves(pos, &list, GEN_ALL);
    score_moves(&list, tt_move, ply);

    int best = -VALUE_INF;
    Move best_move = MOVE_NONE;
    int alpha_orig = alpha;
    int legal = 0, skip_quiets = 0;
    Move quiets[64];
    int quiet_count = 0;

    for (int i = 0; i < list.count; ++i) {
        Move m = pick_move(&list, i);
        if (m == excluded || !pos_is_legal(pos, m)) continue;
        legal++;
        int quiet = !move_is_tactical(m);
        if (quiet && skip_quiets) continue;

        // Shallow-depth pruning, once a real score is secured
        if (!root && best > -VALUE_MATE_IN_MAX && non_pawn_material(pos, pos->side)) {
            if (quiet) {
                if (depth <= 8 && legal > (3 + depth * depth) / (2 - improving)) {
                    skip_quiets = 1;
                    continue;
                }
                if (!checked && depth <= 8 && ss->static_eval != VALUE_NONE &&
                    ss->static_eval + 100 + 100 * depth <= alpha) {
                    skip_quiets = 1;
                    continue;
                }
                if (depth <= 8 && !see_ge(pos, m, -50 * depth)) continue;
            } else {
                if (depth <= 8 && !see_ge(pos, m, -100 * depth)) continue;
            }
        }

        // Singular extension: if every alternative to the hash move fails well below its
        // score, the hash move is forced and deserves an extra ply.
        int extension = 0;
        if (!root && m == tt_move && !excluded && depth >= 8 && hit && tt_depth(tte) >= depth - 3 &&
            (tt_bound(tte) & BOUND_LOWER) && abs(tt_score) < VALUE_MATE_IN_MAX && ply < 2 * S.root_depth) {
            int singular_beta = tt_score - 2 * depth;
            ss->excluded = m;
            int s = search(singular_beta - 1, singular_beta, (depth - 1) / 2, ply);
            ss->excluded = MOVE_NONE;
            if (S.stop) return 0;
            if (s < singular_beta) extension = 1;
            else if (singular_beta >= beta) return singular_beta;  // multi-cut: several moves beat beta
            else if (tt_score >= beta) extension = -1;
        }

        int hist = quiet ? quiet_history(ss, pos->side, pos->board[move_from(m)], m) : 0;

        ss->move = m;
        ss->piece = moved_piece(pos, m);
        ss->cont = &cont_history[ss->piece][move_to(m)];
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
            r -= hist / 16384;
            if (r < 0) r = 0;
            if (r > new_depth - 1) r = new_depth - 1;
            score = -search(-alpha - 1, -alpha, new_depth - r, ply + 1);
            if (score > alpha && r > 0) score = -search(-alpha - 1, -alpha, new_depth, ply + 1);
        } else if (!pv_node || legal > 1) {
            score = -search(-alpha - 1, -alpha, new_depth, ply + 1);
        } else {
            score = alpha + 1;  // force the full-window search below for the first PV move
        }
        if (pv_node && (legal == 1 || score > alpha)) score = -search(-beta, -alpha, new_depth, ply + 1);

        pos_unmake_move(pos, m);
        if (S.stop) return 0;

        if (score > best) {
            best = score;
            if (score > alpha) {
                best_move = m;
                alpha = score;
                if (pv_node) {
                    S.pv[ply][0] = m;
                    for (int j = 0; j < S.pv_len[ply + 1]; ++j) S.pv[ply][j + 1] = S.pv[ply + 1][j];
                    S.pv_len[ply] = S.pv_len[ply + 1] + 1;
                }
                if (root) {
                    S.root_best = m;
                    S.root_best_score = score;
                }
                if (score >= beta) {
                    if (quiet) update_quiet_heuristics(ply, depth, m, quiets, quiet_count);
                    break;
                }
            }
        }
        if (quiet && m != best_move && quiet_count < 64) quiets[quiet_count++] = m;
    }

    if (legal == 0) return excluded ? alpha : checked ? -VALUE_MATE + ply : VALUE_DRAW;

    int bound = best >= beta ? BOUND_LOWER : (best > alpha_orig ? BOUND_EXACT : BOUND_UPPER);
    if (!excluded) tt_store(tte, key, depth, score_to_tt(best, ply), raw_eval, bound, best_move);
    return best;
}

// ---------------------------------------------------------------------------
// Iterative deepening
// ---------------------------------------------------------------------------

// Prints the search result; the PV always starts with `best` (the move that will be played).
static void print_info(int depth, int score, Move best) {
    long long elapsed = now_ms() - S.start_ms;
    long long nps = S.nodes * 1000 / (elapsed > 0 ? elapsed : 1);
    printf("info depth %d seldepth %d ", depth, S.seldepth);
    if (score >= VALUE_MATE_IN_MAX) printf("score mate %d ", (VALUE_MATE - score + 1) / 2);
    else if (score <= -VALUE_MATE_IN_MAX) printf("score mate -%d ", (VALUE_MATE + score) / 2);
    else printf("score cp %d ", score);
    printf("nodes %lld nps %lld hashfull %d time %lld pv", S.nodes, nps, tt_hashfull(), elapsed);
    char buf[6];
    if (S.pv_len[0] > 0 && S.pv[0][0] == best) {
        for (int i = 0; i < S.pv_len[0]; ++i) {
            move_to_str(S.pv[0][i], buf);
            printf(" %s", buf);
        }
    } else {
        move_to_str(best, buf);
        printf(" %s", buf);
    }
    printf("\n");
    fflush(stdout);
}

SearchResult search_run(const Position* pos, const SearchLimits* limits, int silent, int (*poll_stop)(void)) {
    // Copy the position including its state history (needed for repetition detection).
    memcpy(&S.pos, pos, sizeof(Position));
    S.pos.st = S.pos.states + (pos->st - pos->states);
    memset(S.stack, 0, sizeof(S.stack));
    for (int i = 0; i < MAX_PLY + 8; ++i) {
        S.stack[i].static_eval = VALUE_NONE;
        S.stack[i].cont = &cont_sentinel;
    }
    S.nodes = 0;
    S.seldepth = 0;
    S.stop = 0;
    S.silent = silent;
    S.poll_stop = poll_stop;
    S.start_ms = now_ms();
    S.max_nodes = limits->nodes;
    S.root_best = MOVE_NONE;
    S.root_best_score = 0;
    init_time(limits, pos->side);
    tt_new_search();

    SearchResult result = {MOVE_NONE, 0, 0, 0};
    MoveList legal_moves;
    generate_legal(&S.pos, &legal_moves);
    if (legal_moves.count == 0) return result;
    result.best_move = legal_moves.moves[0].move;

    int max_depth = limits->depth > 0 ? limits->depth : MAX_PLY - 8;
    Move prev_best = MOVE_NONE;
    int stability = 0;
    int score = 0;

    for (int depth = 1; depth <= max_depth; ++depth) {
        S.seldepth = 0;
        S.root_depth = depth;
        int delta = 20;
        int alpha = -VALUE_INF, beta = VALUE_INF;
        if (depth >= 4) {
            alpha = score - delta > -VALUE_INF ? score - delta : -VALUE_INF;
            beta = score + delta < VALUE_INF ? score + delta : VALUE_INF;
        }
        // Aspiration windows: widen on fail-low/high until the score fits.
        for (;;) {
            int s = search(alpha, beta, depth, 0);
            if (S.stop) break;
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
        if (S.root_best != MOVE_NONE) result.best_move = S.root_best;
        if (S.stop) {
            // The interrupted iteration found a better move: report it so the last info line
            // matches the bestmove sent to the GUI.
            if (!silent && result.best_move != prev_best && prev_best != MOVE_NONE)
                print_info(depth, S.root_best_score, result.best_move);
            break;
        }

        result.score = score;
        result.depth = depth;
        if (!silent) print_info(depth, score, result.best_move);

        if (result.best_move == prev_best) stability++;
        else stability = 0;
        prev_best = result.best_move;

        if (S.use_time) {
            static const double scale[5] = {2.5, 1.2, 0.9, 0.8, 0.75};
            long long elapsed = now_ms() - S.start_ms;
            if (elapsed >= (long long)(S.soft_ms * scale[stability < 4 ? stability : 4])) break;
        }
    }
    result.nodes = S.nodes;
    return result;
}
