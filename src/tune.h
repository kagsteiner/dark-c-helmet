#ifndef TUNE_H
#define TUNE_H

// Search constants that SPSA may tune: X(name, default, min, max).
// Normal builds turn each one into a compile-time constant. A build with -DSPSA turns them
// into variables and exposes them as UCI spin options (see tools/spsa/spsa.py).
#define SEARCH_PARAMS(X)                  \
    X(rfp_depth, 8, 4, 12)                \
    X(rfp_margin, 77, 30, 160)            \
    X(razor_margin, 268, 100, 500)        \
    X(nmp_base, 3, 2, 5)                  \
    X(nmp_depth_div, 3, 2, 6)             \
    X(nmp_eval_div, 200, 80, 400)         \
    X(iir_depth, 5, 3, 8)                 \
    X(lmp_base, 4, 1, 8)                  \
    X(fut_base, 101, 0, 250)              \
    X(fut_mult, 98, 40, 200)             \
    X(see_quiet, 46, 10, 120)             \
    X(see_noisy, 99, 40, 200)             \
    X(se_depth, 8, 5, 12)                 \
    X(se_margin, 33, 8, 80)  /* x depth / 16 */ \
    X(lmr_base, 72, 0, 150)  /* / 100 */  \
    X(lmr_div, 227, 150, 350) /* / 100 */ \
    X(lmr_hist_div, 14939, 4096, 32768)   \
    X(hist_bonus_mult, 18, 4, 32)         \
    X(hist_bonus_max, 1623, 400, 3200)    \
    X(qs_fut_margin, 145, 50, 300)        \
    X(asp_delta, 17, 8, 50)

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
