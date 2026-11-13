#ifndef TUNE_H
#define TUNE_H

// Search constants that SPSA may tune: X(name, default, min, max).
// Normal builds turn each one into a compile-time constant. A build with -DSPSA turns them
// into variables and exposes them as UCI spin options (see tools/spsa/spsa.py).
#define SEARCH_PARAMS(X)                  \
    X(rfp_depth, 8, 4, 12)                \
    X(rfp_margin, 60, 30, 160)            \
    X(razor_margin, 287, 100, 500)        \
    X(nmp_base, 5, 2, 5)                  \
    X(nmp_depth_div, 3, 2, 6)             \
    X(nmp_eval_div, 196, 80, 400)         \
    X(iir_depth, 5, 3, 8)                 \
    X(lmp_base, 6, 1, 8)                  \
    X(fut_base, 98, 0, 250)              \
    X(fut_mult, 89, 40, 200)             \
    X(see_quiet, 44, 10, 120)             \
    X(see_noisy, 100, 40, 200)             \
    X(se_depth, 8, 5, 12)                 \
    X(se_margin, 29, 8, 80)  /* x depth / 16 */ \
    X(lmr_base, 74, 0, 150)  /* / 100 */  \
    X(lmr_div, 218, 150, 350) /* / 100 */ \
    X(lmr_hist_div, 12235, 4096, 32768)   \
    X(hist_bonus_mult, 21, 4, 32)         \
    X(hist_bonus_max, 1540, 400, 3200)    \
    X(qs_fut_margin, 152, 50, 300)        \
    X(asp_delta, 11, 8, 50)               \
    X(razor_depth, 2, 1, 6)               \
    X(nmp_min_depth, 3, 2, 6)             \
    X(nmp_eval_cap, 3, 1, 6)              \
    X(lmp_depth, 8, 4, 12)                \
    X(fut_depth, 8, 4, 12)                \
    X(see_depth, 8, 4, 12)                \
    X(lmr_min_depth, 3, 2, 6)             \
    X(se_tt_depth, 3, 1, 6)               \
    X(corr_weight_max, 15, 4, 40)         \
    X(corr_limit, 63, 16, 160)  /* cp */ \
    X(corr_pawn_w, 127, 0, 256)  /* / 128 */ \
    X(corr_nonpawn_w, 98, 0, 256)  /* / 128 */

#ifdef SPSA
#define TUNE_DECLARE(name, def, lo, hi) extern int name;
SEARCH_PARAMS(TUNE_DECLARE)
#undef TUNE_DECLARE
#else
#define TUNE_DECLARE(name, def, lo, hi) enum { name = def };
SEARCH_PARAMS(TUNE_DECLARE)
#undef TUNE_DECLARE
#endif

#endif
