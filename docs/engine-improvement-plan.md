# Engine improvement plan (hand-over)

Written 2026-11-10 against commit `6a76af0` (build 148, net v12: 7 king buckets x 768 -> 512,
SCReLU, 8 output buckets). It is a work order for an implementing agent. Each work package is
self-contained: what to change, where, how to test it, and when it counts as done.

Scope: the engine in `src/` and its tools in `tools/`. Do not touch `webapp/`, `human/`,
`about.md` or the tutorial in `docs/tutorial/`.

Elo figures in this plan are guesses from what other engines report. None is measured here.
Line numbers refer to commit `6a76af0`; search for the quoted code if they have moved.

## 1. Ground rules

1. **One change per branch.** Branch from `main`, name it after the package (`wp-a1-tt-align`).
   Never combine two packages in one test.
2. **Read `DEVELOPMENT.md` first.** It defines the testing workflow this plan relies on.
3. **Do not read `src/nnue_net.c`** (230,000 generated lines). Regenerate it only through
   `tools/nnue/embed.py`.
4. **Bench.** `bin/darkhelmet bench` (depth 16) prints a node count. Record the count of
   `main` before starting. Put the bench number in every commit message.
   - A package marked **bench-neutral** must keep the node count identical. If it changes,
     the change has a bug; do not "accept the new number".
   - A package marked **SPRT** changes the count by design.
5. **Correctness after touching `position.c` or `movegen.c`:**
   `python3 tools/perft_suite.py bin/darkhelmet`.
6. **NNUE self-check after touching `nnue.c`:** build with `-DNNUE_VERIFY` and run
   `bench 14`; stderr must report `0 mismatches`.
7. **Strength tests** use `tools/match.sh` (needs `../fastchess/fastchess`):
   - gain test: `SPRT=1 TC=8+0.08 CONCURRENCY=16 GAMES=60000 tools/match.sh <new> <base>`
     (bounds [0, 5]); pass = `H1 was accepted`.
   - no-regression test: add `ELO0=-5 ELO1=0`. With a true difference near zero this needs
     20,000 to 30,000 games, about 11 to 15 hours on this machine. Plan it as an overnight run.
   - `tools/sprt_queue.sh <branch> ...` tests branches one after another and merges those
     that pass. Use it for section 4.
   - The machine must be otherwise idle during a match. Never overwrite `bin/darkhelmet`
     while a match or data generation is using it; build candidates with `make EXE=bin/<name>`.
8. **Speed measurements:** six interleaved runs of `bench 17` for base and candidate, compare
   mean nodes per second. Differences under 0.5% are noise.
9. **Chess960 is the product's priority.** For every merged strength change in sections 4 and
   5, also run a 2,000-game Chess960 match
   (`VARIANT=fischerandom BOOK=tools/books/frc960.epd`) and report the result. A clear loss
   there (below -10 Elo outside the error bar) blocks the merge.
10. **A failed test is a result.** Record it in the results table (section 7), leave the
    branch unmerged, and move on. Do not tune a failed idea more than once without asking.
11. **Ask the user before** starting anything in section 6 (hours of compute each), before
    deleting data, and before pushing.

## 2. Order of work

| Step | Package | Kind | Guess |
|---|---|---|---|
| 1 | A1-A4: small speed items | bench-neutral | under 1% each |
| 2 | C0: continuation-history sentinel | SPRT | unknown sign, small |
| 3 | C1: more correction histories | SPRT | +10 to +20 |
| 4 | C2: history-based pruning | SPRT | +5 to +10 |
| 5 | C3: 4-ply continuation history | SPRT | +2 to +5 |
| 6 | C4: reduce losing captures | SPRT | +2 to +5 |
| 7 | C5: scale eval by 50-move counter | SPRT | +2 to +5 |
| 8 | C6: SPSA re-tune of all new parameters | tuning | +5 to +15 |
| 9 | B: move picker sort | SPRT (no-regression) | 2-4% speed |
| 10 | D1-D3: network experiments | ask first | uncertain |

## 3. Package A: small speed items (bench-neutral)

Do these as four commits on one branch; each must keep the bench count identical. Finish with
one speed measurement of the whole branch. No SPRT needed.

### A1. Cache-line-aligned transposition table

- **Where:** `src/tt.c`, `tt_resize` (`calloc`) and `tt_free`.
- **Why:** a `TTBucket` is 64 bytes so that one probe touches one cache line. `calloc` does
  not guarantee 64-byte alignment; on Linux and Windows large blocks are offset by 16 bytes,
  so every bucket straddles two lines. macOS happens to page-align.
- **Change:** allocate with 64-byte alignment and zero with `memset`. Use `posix_memalign` on
  POSIX, `_aligned_malloc` / `_aligned_free` under `_MSC_VER`. Keep the Emscripten build
  compiling (`posix_memalign` exists there).
- **Done when:** bench identical; `(uintptr_t)table % 64 == 0` asserted once in a debug run.

### A2. Skip the checkers computation after a null move

- **Where:** `src/position.c`, `set_check_info` and `pos_make_null`.
- **Why:** a null move is only made when the side to move is not in check
  (`search.c`, null-move block requires `!checked`), so after it the new side to move cannot
  be in check either. `set_check_info` still runs two magic lookups for `checkers`.
- **Change:** split `set_check_info` into a pinned-pieces part and a checkers part; in
  `pos_make_null` set `st->checkers = 0` and compute only the pinned pieces (they are for the
  new side to move, so they must be recomputed).
- **Done when:** bench identical, perft suite passes.

### A3. Do not prefetch rows for a perspective whose king view changed

- **Where:** `src/nnue.c`, `nnue_prefetch`.
- **Why:** if the move changed perspective `p`'s king bucket or mirror half, that perspective
  is rebuilt through the accumulator cache and never reads the prefetched rows.
- **Change:** `if (king_view_changed(pos->st, p)) continue;` at the top of the perspective
  loop (move `king_view_changed` above `nnue_prefetch`).
- **Done when:** bench identical, `NNUE_VERIFY` clean.

### A4. Prefetch the TT bucket in quiescence search

- **Where:** `src/search.c`, `qsearch`, after `pos_make_move` (line 480). `search` already
  does this at line 645.
- **Change:** add `tt_prefetch(pos->st->key);`.
- **Done when:** bench identical. If the speed measurement shows nothing, keep it anyway for
  consistency; it is one line.

## 4. Package C: search improvements (one SPRT each)

Use `tools/sprt_queue.sh` so each candidate is tested on top of the ones already merged.
New constants go into `SEARCH_PARAMS` in `src/tune.h` so that C6 can tune them.

### C0. Continuation-history sentinel is written to

- **Where:** `src/search.c`. `cont_sentinel` (line 80) is commented "never updated", but
  `update_quiet_heuristics` (lines 376-377) writes through `ss[-1].cont` and `ss[-2].cont`
  without checking. At ply 0 and 1, and after a null move, those point at the sentinel.
- **Effect today:** the sentinel acts as an unintended extra piece-to history. It is shared by
  all threads without synchronisation and is not reset by `search_clear`, so results depend
  on earlier games in the same process.
- **Change, two candidates to test separately:**
  1. Skip the update when the pointer is `&cont_sentinel`.
  2. Keep the behaviour but make it deliberate: one sentinel table per thread inside
     `SearchThread`, cleared in `search_clear`.
- **Done when:** one of the two passes a no-regression SPRT; merge the one with the better
  result. If both fail clearly, keep the code and fix only the comment.

### C1. More correction histories

- **Where:** `src/position.h` (`State`), `src/position.c` (`state_add`, `state_remove`,
  `pos_set_fen`), `src/search.c` (`correction_entry`, `corrected_eval`, `update_correction`,
  `SearchThread`, `search_clear`), and the incremental-state check used by
  `tools/perft_suite.py` (find it in `src/perft.c` / `src/uci.c` and extend it to the new keys).
- **Today:** one table `correction[2][CORR_SIZE]`, indexed by side to move and pawn key.
- **Step C1a, non-pawn keys:**
  - Add `uint64_t nonpawn_key[2]` to `State`: XOR of `ZOBRIST_PIECE[pc][sq]` over all
    non-pawn pieces (king included) of that colour. Maintain it in `state_add` /
    `state_remove` next to `pawn_key`; initialise in `pos_set_fen`.
  - Add `int nonpawn_correction[2][2][CORR_SIZE]` (`[side to move][piece colour][key]`).
  - `corrected_eval` adds a weighted sum; `update_correction` applies the same update rule to
    every table. Starting weights, as new tune parameters in 1/128:
    pawn 128, non-pawn 96 each. These are starting guesses for SPSA, not known-good values.
  - Keep the entries `int`: `CORR_LIMIT` can exceed the int16 range.
- **Step C1b, continuation correction (separate branch and SPRT, after C1a):**
  - Table `int cont_correction[2][12][64]`, indexed by side to move and the previous move's
    piece and target square (`ss[-1].piece`, `move_to(ss[-1].move)`).
  - Skip both lookup and update when `ss[-1].move == MOVE_NONE` (root, after a null move).
  - Starting weight 64/128.
- **Pitfalls:** `State` is copied on every move; adding 16 bytes is fine, but check the speed
  measurement. `corrected_eval` is also called in `qsearch`; `ss` must be passed in for C1b.
- **Done when:** perft suite passes with the extended check; each step passes a gain SPRT.

### C2. History-based pruning of quiet moves

- **Where:** `src/search.c`, the shallow-depth pruning block (lines 604-621). The combined
  history `hist` is currently computed after it (line 638); move that computation before the
  block (it is only defined for quiet moves).
- **Change:** inside `if (quiet)`, after the late-move and futility rules:
  `if (depth <= hp_depth && hist < -hp_margin * depth) continue;`
  New parameters: `hp_depth` 4 (range 2-8), `hp_margin` 4000 (range 1000-8000). The history
  sum is three tables of at most 16384 each, so its range is about +-49000.
- **Second step, same branch only if the first passes:** subtract `hist / fut_hist_div`
  (start 64) from the futility margin and from the quiet SEE threshold.
- **Done when:** gain SPRT passes.

### C3. Four-ply continuation history

- **Where:** `src/search.c`, `quiet_history` (line 172) and `update_quiet_heuristics`
  (lines 371-378).
- **Change:** add `(*ss[-4].cont)[piece][to]` to the sum and update it with the same bonus.
  The stack has four guard entries below ply 0 (`t->stack[ply + 4]`), all initialised to the
  sentinel in `search_run`, so `ss[-4]` is always valid. Apply the outcome of C0 to it.
- **Note:** this widens the range of the history sum; `lmr_hist_div` and the C2 margin were
  set for three tables. Try once as is; if it fails, try once with the 4-ply term halved.
- **Done when:** gain SPRT passes.

### C4. Reduce losing captures

- **Where:** `src/search.c`, the LMR condition at line 651
  (`depth >= lmr_min_depth && legal > 1 + pv_node && quiet`).
- **Today:** only quiet moves are reduced; captures with negative SEE are searched at full
  depth after all quiets.
- **Change:** capture `mp.stage == STAGE_BAD_NOISY` right after `picker_next` returns (the
  stage changes on the next call) and let such moves into the LMR branch with
  `r = lmr_table[...] - pv_node - gives_check`, clamped as for quiets. Do not apply the
  killer or history adjustments to them.
- **Done when:** gain SPRT passes.

### C5. Scale the evaluation by the 50-move counter

- **Where:** `src/search.c`, `corrected_eval` (line 399).
- **Change:** before adding the correction, `raw = raw * (200 - pos->st->rule50) / 200`.
- **Pitfall:** the TT key does not include the counter, and the TT stores the raw evaluation.
  Keep storing the unscaled `raw_eval` and scale only when it is used, exactly as the
  correction is applied today.
- **Done when:** gain SPRT passes. This mainly helps conversion of won endings, so the 8+0.08
  result may be small; accept on a passed no-regression test plus a non-negative Chess960 match.

### C6. SPSA re-tune

- **When:** after C0-C5 are settled.
- **How:** `make spsa` and `tools/spsa/spsa.py` (read its header for usage). Include all
  parameters added in C1, C2 and C4 plus the existing ones.
- **Done when:** the tuned values pass a gain SPRT against the untuned build. Check first
  whether an SPSA run is already in progress (see `data/` and running processes); if so, ask
  the user before starting another.

## 5. Package B: move picker sort

- **Where:** `src/search.c`, `pick_move` (line 218) and `STAGE_GEN_QUIET` / `STAGE_QUIET` in
  `picker_next`.
- **Measured:** `pick_move` takes about 6% of search time. On `bench 15` there were 6.26
  million picks scanning 94.9 million entries, 15 per pick and 27 per node. The selection
  sort is lazy, which is good when a cutoff comes early and bad when many quiets are tried.
- **First, measure** (scratch build, counters): lists generated, picks per list, list length,
  separately for captures and quiets. If quiet lists are mostly abandoned after one or two
  picks, stop here and record that; the sort is then already near optimal.
- **Change if the numbers support it:** in `STAGE_GEN_QUIET`, after scoring, run one partial
  insertion sort that orders only moves with a score above `-quiet_sort_margin * depth`
  (start 3500) to the front, and return the rest in generation order. `STAGE_QUIET` then walks
  the list by index. Captures keep the selection sort (short lists, SEE on pick).
- **Test:** node count changes because ties and low-history moves are ordered differently.
  Requires at least +1.5% nodes per second **and** a passed no-regression SPRT (overnight).

## 6. Package D: network experiments (ask the user before each)

Training data lives outside OneDrive (see `tools/nnue/pipeline.sh` and `train_round.sh` for
the paths in use; ask the user if unclear). Each training run takes hours.

### D1. Sweep the score/result mix (`lambda`)

- **Where:** `tools/nnue/trainer.c`, third optional argument of `train` (default 0.75).
- **Do:** train the v12 architecture on the v12 data with `lambda` 0.6 and 0.9, SPRT each
  against the engine with v12 (gain bounds), plus the Chess960 match.
- **Done when:** both results are recorded; adopt a value only if it passes.

### D2. King-bucket layout versus speed

- **Background:** one accumulator refresh happens per three evaluations, because the 7-bucket
  layout gives each file pair of the back rank its own bucket. On the v10 data a 4-bucket
  layout scored the same as 7 buckets (+33.4 versus +33.7 against v9, see `DEVELOPMENT.md`),
  measured before the accumulator cache existed.
- **Do:** train a 4-bucket net on the current data; compare nodes per second and run a
  head-to-head SPRT against the 7-bucket net at equal time.
- **Done when:** recorded. Adopt only on a head-to-head win.

### D3. Architecture changes (design first, no code yet)

Two options add capacity at little inference cost; both need trainer, engine and file-format
changes and should start with a short written design for the user:

- pairwise multiplication of the two halves of each accumulator before the output layer;
- one small hidden layer between accumulator and output.

Deliver a design note with expected inference cost (measured from a prototype forward pass on
random weights) before training anything.

## 7. Results table (fill in as you go)

| Package | Branch | Bench before -> after | Speed | SPRT result (Elo, games, verdict) | 960 match | Merged |
|---|---|---|---|---|---|---|
| A1-A4 | `wp-a-speed` | 5,103,920 -> 5,103,920 | bench 17 +0.8% nps (6 interleaved runs) | n/a | n/a | yes, 7188f23 |
| C0 | `wp-c0-skip` (candidate 1) | 5,103,920 -> 5,220,578 | | [-5, 0]: -2.1 +/- 2.7 after 16,700 games, LLR -1.12, stopped by a reboot (later games spoiled by time losses): not passed | | no |
| C0 | `wp-c0-thread` (candidate 2) | 5,103,920 -> 5,059,127 | | running | | |
| C1a | | | | | | |
| C1b | | | | | | |
| C2 | | | | | | |
| C3 | | | | | | |
| C4 | | | | | | |
| C5 | | | | | | |
| C6 | | | | | | |
| B | (measured on `main`, `bench 15`) | | quiet lists: 381,841, mean length 31.7, mean 8.4 picks, 41% need 7+ picks (only 22% end after 1-2); captures: mean length 2.8, 1.9 picks. The sort change is worth trying | | | |
| D1 | | | | | | |
| D2 | | | | | | |

## 8. Already done (for context)

Commit `6a76af0`: per-search position copy without accumulators (`pos_copy_for_search`),
fused accumulator-cache refresh, int16 history tables. Bench-neutral; `bench 17` +1.3% nodes
per second, data generation at 5,000 nodes per move about 9% less time.

Profile at that commit (`bench 17`, Apple M5 Max): NNUE update 20%, cache refresh 11%, output
layer 9%, ancestor walk and prefetch 6%, SEE 9%, move picking 12%, search body 7%, move
generation 5%, TT probe 5%, `set_check_info` 4%, rest about 12%. The NNUE loops compile to
clean NEON; there is nothing to gain from hand-written intrinsics on Apple silicon.
