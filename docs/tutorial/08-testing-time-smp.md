# Chapter 8 — Testing like engine developers do; time management; Lazy SMP

> **Files:** [`tools/match.sh`](../../tools/match.sh), [`tools/perft_suite.py`](../../tools/perft_suite.py),
> [`tools/spsa/spsa.py`](../../tools/spsa/spsa.py), [`src/uci.c`](../../src/uci.c) (bench),
> [`src/search.c`](../../src/search.c) (time management, threads), [DEVELOPMENT.md](../../DEVELOPMENT.md)

If one chapter of this series explains the gap between a 2100-Elo hobby engine and a
3400-Elo one, it might be this one. Chapters 3–7 describe *what* the engine does. This one
describes *how we knew* that each piece was an improvement. Without that, chapter 4 would be
a list of guesses, and probably half of them would make the engine weaker.

## 8.1 Three kinds of testing

| question | tool | cost |
|---|---|---|
| Is it **correct**? | perft, `NNUE_VERIFY`, exhaustive checks | seconds |
| Did it **change behaviour**? | `bench` node count | seconds |
| Is it **stronger**? | engine-vs-engine games, SPRT | minutes to hours |

### Correctness

* **Perft** (chapter 2) counts all positions to a fixed depth from known test positions and
  compares with published numbers. `tools/perft_suite.py` runs six of the standard positions
  (Kiwipete and others) and also checks that the incrementally updated hash keys match freshly
  computed ones.
* **`NNUE_VERIFY`** (chapter 7) recomputes every accumulator from scratch and compares it with
  the incrementally updated one.
* **Exhaustive tests** where the input space allows: `pos_is_pseudo_legal` (chapter 2), which
  must accept exactly the moves the generator produces, was compared on all 65,536 possible
  move codes in about 28,000 positions (1.85 billion checks, 0 mismatches). It found one real bug:
  the unused flag codes 6 and 7 had been accepted.

### Behaviour: the bench fingerprint

`darkhelmet bench` searches 18 fixed positions to depth 16, single-threaded, and prints the
total node count ([`src/uci.c:170`](../../src/uci.c#L170)):

```
5539501 nodes 3331028 nps
```

The search is completely deterministic on one thread, so that number is a **fingerprint of
the engine's behaviour**. Any change to search, evaluation or move ordering changes it.
That makes it a very powerful tool:

* A **pure speed optimisation** (the staged move picker's lazy SEE, the accumulator cache,
  SIMD code) must leave the node count *exactly* unchanged. If it does, it's proven to play
  the same moves, just faster. If not, there's a bug.
* A **refactoring** (making the search constants tunable for SPSA) must also leave it
  unchanged.
* A **real change** changes it, and the new number goes into the commit message, so that
  anyone can check which version they're running.

In this repository, the bench number was checked before every commit to `src/`.

## 8.2 Why it takes so many games

Engine strength is measured in games, and games are noisy. Even between two equally strong
engines, results scatter a lot, and draws are frequent. A rough rule of thumb for the 95 %
confidence interval of an Elo measurement:

```
± (450 … 550) / √games      Elo
```

(depending on the draw rate). So:

| games | ± Elo (95 %) |
|---|---|
| 100 | ±50 |
| 400 | ±25 |
| 1,000 | ±16 |
| 4,000 | ±8 |
| 16,000 | ±4 |

Most improvements in a mature engine are worth **2–10 Elo**. To see a +5 Elo change, you need
thousands of games. That's why tests are played at **very short time controls**: 8 seconds
+ 0.08 per move per game here, about 35 games per minute with 16 games in parallel. Testing at blitz or rapid
time controls would give more "realistic" games, but far too few of them.

Is a short time control representative? Mostly yes: what helps at 8 seconds usually helps at
3 minutes too. The exceptions are time management (chapter 8.5) and anything that only pays
off at great depth. Our HIARCS matches showed both sides: build 57 was +220 ahead at 20+0.2,
but only +127 at 3+2.

### Fair conditions

[`tools/match.sh`](../../tools/match.sh) runs matches with **fastchess**, set up like this:

* **Openings:** 4,000 random but balanced positions (`tools/books/random8.epd`, 8 random moves
  each), so the engines don't play the same game over and over.
* **Game pairs:** every opening is played twice, with colours reversed. An opening that's
  winning for White can't distort the result, because each engine gets it once.
* Same hash size, single thread, same time control.

The game pairs also give the **pentanomial statistics** you see in the logs
(`Ptnml(0-2): [0, 1, 46, 58, 95]`): how many pairs ended 0, ½, 1, 1½ or 2 points for the new
engine. Pair results scatter less than single games, so the statistics are more precise.

## 8.3 SPRT: stopping as soon as the answer is clear

How many games do you play? If the change is +40 Elo, a few hundred are enough. If it's +2, you
need tens of thousands. You don't know in advance.

The **sequential probability ratio test** (SPRT) solves that. You state two hypotheses:

* **H0:** the change is worth 0 Elo (or less);
* **H1:** the change is worth 5 Elo (or more);

and two error rates (5 % each here). After each game pair, fastchess computes the
**log-likelihood ratio** (LLR): how much more likely the results are under H1 than under H0. The
test stops when the LLR leaves the interval [−2.94, +2.94] (that's ln(0.95/0.05) = ln 19):

* LLR ≥ +2.94: **H1 accepted**: the change is an improvement. Merge.
* LLR ≤ −2.94: **H0 accepted**: it isn't (or not by 5 Elo). Discard.

From this repository:

| change | games until decision | result |
|---|---|---|
| accumulator cache | 1,062 | +39.1 ± 11.4, H1 |
| staged move picker | 1,018 | +45.3 ± 12.6, H1 |
| SPSA-tuned constants | 2,092 | +20.5 ± 8.3, H1 |
| net v9 vs v8 | 4,866 | +9.7 ± 5.5, H1 |
| capture history | 18,942 | +3.5 ± 2.8, H1 |
| kb7 + queen buckets vs kb7 | 4,568 | −7.5 ± 5.8, H0 |

The SPRT automatically spends few games on clear cases and many on close ones. The Elo
figure it reports is an estimate; the decision is what counts.

**The discipline that goes with it:** run the test to the end. Stopping early because "it looks
good" (or bad) after 300 games is exactly the mistake the SPRT protects against. Early leads
regularly evaporate. (One exception in this repository: the time management change was merged
before its SPRT finished, as a deliberate decision, because short games understate its effect.)

For **simplifications** (removing code that might be useless), the bounds are reversed:
`ELO0=-5 ELO1=0`. H1 means "not worse", so the simpler code can stay.

### What a fixed-game test is still good for

To *measure* rather than *decide*, a fixed number of games is fine. The ablation tables in
chapters 4 and 5 used 600 games per technique: enough to see that late move reductions are
worth a lot, not enough to tell +3 from +8.

## 8.4 SPSA: tuning the constants

Chapter 4 is full of constants: RFP margin 77, LMR divisor 2.27, SEE thresholds 46 and 99,
and so on. SPRT can tell whether *one* changed value is better, but trying out 21 constants one by
one would take months.

**SPSA** (simultaneous perturbation stochastic approximation) tunes all of them at once
([`tools/spsa/spsa.py`](../../tools/spsa/spsa.py)):

1. Take the current values θ.
2. Choose a random direction: +1 or −1 for each constant.
3. Play a game pair between θ + c·direction and θ − c·direction.
4. Move θ a little towards the winner: `θ += a · (wins − losses) · direction`.
5. Repeat tens of thousands of times, with the step sizes `a` and `c` slowly shrinking.

Each single game pair says almost nothing. But over 16,000 pairs, every constant drifts in the
direction that wins more often. The trick that makes it efficient: every game pair gives
information about *all* constants at once.

For this, the engine has a special build (`make spsa`) in which the constants of
[`src/tune.h`](../../src/tune.h) are UCI options instead of compile-time constants. Our run:
32,000 games at 5+0.05 in 10 hours, then an SPRT of the result: **+20.5 Elo**, without a single
new idea. Most values moved only slightly (RFP margin 80 → 77, aspiration window 20 → 17), but
many small improvements add up.

SPSA and Texel tuning (chapter 6) are related: both let data choose parameters. Texel uses
positions with known results (fast, but only for the evaluation); SPSA uses games (slow, but works
for anything, including search parameters).

## 8.5 Time management

In a real game, the engine must decide how long to think about each move. The basic budget
([`src/search.c:126`](../../src/search.c#L126)):

```c
soft = avail / 25 + inc * 3 / 4;     // target time: 1/25 of the remaining time + 3/4 of the increment
hard = min(soft * 3, avail * 3 / 4); // absolute limit, checked during the search
```

* **Hard limit:** the search is stopped wherever it is (`check_stop`, every 2,048 nodes).
* **Soft limit:** checked only between iterations: if it's exceeded, no new iteration is
  started. An unfinished iteration is mostly wasted (chapter 3), so it's better not to start
  one that won't finish.

The soft limit is then scaled by three signals after each iteration
([`src/search.c:798`](../../src/search.c#L798)):

```c
// 1. stability: how many iterations in a row the best move hasn't changed
static const double stability_scale[5] = {2.5, 1.2, 0.9, 0.8, 0.75};
// 2. effort: the share of nodes spent on the best move; a clear favourite needs less time
scale *= (1.5 - best_share) * 1.35;
// 3. score trend: if the score dropped since the last iteration, think longer
scale *= clamp(1.0 + (prev_score - score) * 0.01, 0.75, 1.5);
```

The idea: think **briefly when the decision is easy** (the best move has been the same for a
while and gets almost all of the search effort), and **longer when it's hard** (the best
move just changed, or the score is falling, which often means the engine has just discovered a
problem). A recapture takes a fraction of a second; a critical middlegame decision can take
several times the average.

`Move Overhead` (default 20 ms) is subtracted from the remaining time, to account for the
GUI's and operating system's delays. Losing on time with a winning position is the most
avoidable loss there is.

## 8.6 Lazy SMP: using several cores

Parallelising alpha-beta is notoriously hard, because the algorithm is inherently sequential:
the result of the first move determines the window for the next. Decades of research produced
complex schemes (YBWC, DTS). Then, around 2015, the chess programming community found that a
far simpler idea worked as well or better: **Lazy SMP**.

([`src/search.c:852`](../../src/search.c#L852)):

* Every thread searches **the same position** with iterative deepening, independently.
* They share **only the transposition table.**
* The main thread manages time and output; when it stops, all helpers stop
  (`stop_all`).

That looks pointless: why would four threads searching the same tree be faster? Because they
*don't* search exactly the same tree. Small differences in timing make them reach different
parts at different times, and each thread stores its results in the shared table. A thread that
gets to a node finds an entry another thread just computed, takes the cutoff or the move, and
continues elsewhere. The threads effectively split the work through the table, without any
explicit coordination.

What it brings here: 4 threads vs 1 thread, same time control: **+176 Elo** (62 games, so a
rough number). The result isn't linear in the number of threads, but each doubling is still
worth a lot.

Implementation details that matter:

* Each thread has its **own** position copy, search stack and history tables. Only the TT is
  shared, and writes to it aren't synchronised: a torn write between two threads can produce an
  entry with mismatched fields. That's accepted, and why the TT move is always validated with
  `pos_is_pseudo_legal` before use (chapter 5).
* Helper threads get **8 MB stacks** (the default on macOS for secondary threads is 512 KB, not
  enough for a deep recursive search, [`src/search.c:837`](../../src/search.c#L837)).
* With several threads, the search is **no longer deterministic**. The bench fingerprint only
  works single-threaded, and all SPRTs in this repository were run with one thread per engine.

## 8.7 Pitfalls

1. **Too few games.** "+30 Elo after 100 games" means "somewhere between −20 and +80". Use SPRT
   or enough games.
2. **Testing several changes at once.** If the combination gains 10 Elo, one part may be +15 and
   the other −5. Test changes one at a time.
3. **Stopping tests early** (8.3).
4. **Comparing against other engines to measure your own progress.** It's interesting (in this
   repository: HIARCS +250, Shredder −87), but self-play SPRT is far more sensitive. Gains measured against your own previous version usually translate to about
   half to two thirds against other engines.
5. **Tuning on too short a time control.** SPSA at 5+0.05 might choose margins that are too
   aggressive for longer games. The confirming SPRT should be at a different (longer) time control
   than the tuning itself.
6. **Forgetting the bench check.** A "speed optimisation" that changes the node count has changed
   the engine. It might still be good, but then it needs an SPRT, not just a speed measurement.

## 8.8 Try it yourself

```bash
make && ./bin/darkhelmet bench                          # the fingerprint
python3 tools/perft_suite.py bin/darkhelmet             # move generator correctness
SPRT=1 TC=8+0.08 CONCURRENCY=8 tools/match.sh bin/new bin/old   # a real test
```

Exercises, if you like:

* A change gains +3 Elo. Roughly how many games does the SPRT [0, 5] need on average? (Hint:
  +3 is closer to H1 than to H0, but not by much.)
* Why is the hard time limit `soft × 3` and not, say, `soft × 10`?
* In Lazy SMP, all threads search the same depth. Some engines let helper threads search one ply
  deeper, or skip some depths. Why might that help?
* Find a change in DEVELOPMENT.md's history that looked good in theory and was rejected by SPRT,
  or one where the measured gain was much larger than expected. What explains the difference?

---

This is the last chapter. The [README](README.md) lists them all, and
[DEVELOPMENT.md](../../DEVELOPMENT.md) has the full measured history of the engine: every
change, every net, and what it was worth.
