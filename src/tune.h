#ifndef TUNE_H
#define TUNE_H

// Search constants that SPSA may tune: X(name, default, min, max).
// Normal builds turn each one into a compile-time constant. A build with -DSPSA turns them
// into variables and exposes them as UCI spin options (see tools/spsa/spsa.py).
#define SEARCH_PARAMS(X)                  \
    X(rfp_depth, 8, 4, 12)                \
    X(rfp_margin, 80, 30, 160)            \
    X(razor_margin, 250, 100, 500)        \
    X(nmp_base, 3, 2, 5)                  \
    X(nmp_depth_div, 3, 2, 6)             \
    X(nmp_eval_div, 200, 80, 400)         \
    X(iir_depth, 4, 3, 8)                 \
    X(lmp_base, 3, 1, 8)                  \
    X(fut_base, 100, 0, 250)              \
    X(fut_mult, 100, 40, 200)             \
    X(see_quiet, 50, 10, 120)             \
    X(see_noisy, 100, 40, 200)            \
    X(se_depth, 8, 5, 12)                 \
    X(se_margin, 32, 8, 80)  /* x depth / 16 */ \
    X(lmr_base, 75, 0, 150)  /* / 100 */  \
    X(lmr_div, 225, 150, 350) /* / 100 */ \
    X(lmr_hist_div, 16384, 4096, 32768)   \
    X(hist_bonus_mult, 16, 4, 32)         \
    X(hist_bonus_max, 1600, 400, 3200)    \
    X(qs_fut_margin, 150, 50, 300)        \
    X(asp_delta, 20, 8, 50)

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
