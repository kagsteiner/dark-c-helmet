# Chapter 3 — Search basics: alpha-beta, PVS, iterative deepening, transposition table, quiescence

> **Files:** [`src/search.c`](../../src/search.c), [`src/tt.h`](../../src/tt.h),
> [`src/tt.c`](../../src/tt.c), [`src/position.c`](../../src/position.c) (draw detection),
> [`src/types.h`](../../src/types.h) (score constants)

Chapters 1 and 2 built a board that can play moves forward and backward very quickly. This
chapter turns it into something that *thinks*: a tree search that looks ahead, assigns a
score to every line and picks the move whose worst case is best.

Here is the number that this chapter is about. From the starting position, Dark C. Helmet
searches to depth 22 like this:

```
depth  8  nodes      6602  time      3 ms
depth 12  nodes     59864  time     16 ms
depth 16  nodes    184168  time     45 ms
depth 20  nodes    721033  time    174 ms
depth 22  nodes   1892224  time    456 ms
```

A full minimax tree to depth 22, with about 35 legal moves per position, would have
35²² ≈ 10³⁴ nodes. We search **1.9 million**. From depth 8 to depth 22 the node count grows by
a factor of about 1.5 per ply (the *effective branching factor*), not 35.

Part of that gap comes from the pruning and reduction tricks of chapter 4. But the
foundation, the part without which none of the tricks would work, is the subject of this
chapter: alpha-beta with a principal variation search, iterative deepening, aspiration
windows, the transposition table and the quiescence search.

## 3.1 Negamax and alpha-beta

### Negamax

Minimax alternates between a maximising and a minimising player. Chess engines use the
equivalent **negamax** form: every score is from the point of view of *the side to move*,
and a child's score is negated when it is passed up the tree:

```c
int negamax(int depth) {
    if (depth == 0) return evaluate();          // from the side to move's view
    int best = -INFINITY;
    for (each move m) {
        make(m);
        int score = -negamax(depth - 1);         // the opponent's score, negated
        unmake(m);
        best = max(best, score);
    }
    return best;
}
```

One function and no case distinction between White and Black. That's why `evaluate()`
in this engine returns its score from the side to move's view (chapters 6 and 7).

### Alpha-beta

Alpha-beta passes a **window** `(alpha, beta)` down the tree:

* `alpha` is the score the side to move is already guaranteed somewhere else (a lower
  bound). Moves scoring ≤ alpha are of no interest.
* `beta` is the score at which the *opponent* would avoid this position altogether. Once a
  move reaches beta, the remaining moves don't need to be searched: the opponent won't
  allow this line. That is the **beta cutoff**.

```c
int alphabeta(int alpha, int beta, int depth) {
    if (depth == 0) return evaluate();
    int best = -INFINITY;
    for (each move m) {
        make(m);
        int score = -alphabeta(-beta, -alpha, depth - 1);   // window flips with the side
        unmake(m);
        if (score > best) {
            best = score;
            if (score > alpha) alpha = score;
            if (score >= beta) break;                        // cutoff
        }
    }
    return best;
}
```

The result is *exactly* the minimax value, provided it lies inside the window. If not, the
returned score is only a bound:

| returned score | meaning | bound type in the TT (3.6) |
|---|---|---|
| `score <= alpha` (all moves failed low) | true value ≤ score | **upper** bound |
| `alpha < score < beta` | exact value | **exact** |
| `score >= beta` (cutoff) | true value ≥ score | **lower** bound |

Our engine is **fail-soft**: it returns `best`, which can lie outside the window, rather
than clamping to alpha or beta (fail-hard). A fail-soft bound is tighter, and tighter
bounds are more useful in the transposition table.

### Why move ordering is everything

With perfect move ordering, the first move searched at every cut node causes the cutoff,
and alpha-beta visits about `b^(d/2)` nodes instead of `b^d`. Effectively it searches
twice as deep in the same time. With random ordering, the gain mostly disappears. All of
chapter 5 (hash move, captures by value, killers, history tables) exists to get close to
the perfect case. It's worth knowing the three kinds of nodes in an ideal tree:

* **PV nodes:** the window is open (`beta - alpha > 1`), and the exact score is needed.
  There are few of them, one chain per iteration (the *principal variation*).
* **Cut nodes:** one good move causes a beta cutoff. Ideally it's the first one tried.
* **All nodes:** every move fails low, and all of them must be searched.

Most of the clever tricks in chapter 4 are about guessing correctly which kind of node
you're in, and saving work in cut and all nodes.

## 3.2 Scores: centipawns, mates and draws

[`src/types.h:82`](../../src/types.h#L82):

```c
#define VALUE_INF 32000
#define VALUE_MATE 31000
#define VALUE_MATE_IN_MAX (VALUE_MATE - MAX_PLY)
#define VALUE_NONE 32001
#define VALUE_DRAW 0
```

Normal scores are centipawns (100 = one pawn). Mate is encoded in the same integer range:
a side that is mated at ply `p` returns `-VALUE_MATE + p`
([`src/search.c:689`](../../src/search.c#L689)):

```c
if (legal == 0) return excluded ? alpha : checked ? -VALUE_MATE + ply : VALUE_DRAW;
```

Because the score includes the distance from the root, a mate in 3 scores higher than a
mate in 5, and the engine always takes the fastest mate. Any score beyond
`VALUE_MATE_IN_MAX` is a mate score, and `uci.c` prints it as `score mate N`.

### Mate distance pruning

[`src/search.c:518`](../../src/search.c#L518):

```c
int mated = -VALUE_MATE + ply;       // the worst we can do from here: mated right now
int mating = VALUE_MATE - ply - 1;   // the best: mate with the next move
if (alpha < mated) alpha = mated;
if (beta > mating) beta = mating;
if (alpha >= beta) return alpha;
```

If a mate in 4 has already been found, a line at ply 9 can never be better: even the fastest
possible mate from there is slower. These lines are cut immediately. That doesn't gain much
Elo, but it speeds up mate searches a lot.

### Draws

[`src/position.c:456`](../../src/position.c#L456) handles repetition, the 50-move rule and
insufficient material. Three details are worth copying:

1. **One repetition inside the search tree counts as a draw.** If a position repeats once
   inside the tree, the side that could deviate would have done so if it were good, so the
   engine treats it as a draw immediately. *Before* the root (in the game history) a
   position must have occurred twice, because a single repetition in the game isn't a draw
   yet.
2. **Only every second ply, and only back to the last irreversible move** (`rule50`) or null
   move. The loop starts at `i = 4`: a position can't repeat after 2 plies, since that would
   need each side to have moved without changing anything.
3. **Checkmate beats the 50-move rule.** If the 100th half-move delivers mate, the game is
   lost, not drawn. `pos_is_draw` checks for legal moves when in check.

## 3.3 Principal variation search (PVS)

A search with a *null window* `(alpha, alpha + 1)` can't return an exact score. It only
answers a yes/no question: "is this move better than alpha?" That's much cheaper, because
almost every node in it is a cut or all node, so cutoffs happen everywhere.

PVS exploits that. In a PV node, after the first move (presumably the best, thanks to move
ordering) has been searched with the full window, every other move is first tested with a
null window:

* If it fails low (score ≤ alpha), as expected, it's done, and cheaply.
* Only if it unexpectedly beats alpha is it searched **again** with the full window, to get
  its exact score.

The actual code ([`src/search.c:642`](../../src/search.c#L642)) combines this with late
move reductions (chapter 4), which is why there are three cases:

```c
if (depth >= 3 && legal > 1 + pv_node && quiet) {
    // late quiet move: reduced null-window search, re-search at full depth if it beats alpha
    int r = ...;                                                     // chapter 4
    score = -search(t, -alpha - 1, -alpha, new_depth - r, ply + 1);
    if (score > alpha && r > 0) score = -search(t, -alpha - 1, -alpha, new_depth, ply + 1);
} else if (!pv_node || legal > 1) {
    // null-window search at full depth
    score = -search(t, -alpha - 1, -alpha, new_depth, ply + 1);
} else {
    score = alpha + 1;  // first move of a PV node: go straight to the full window below
}
if (pv_node && (legal == 1 || score > alpha))
    score = -search(t, -beta, -alpha, new_depth, ply + 1);           // full window
```

Note that `pv_node` is simply `beta - alpha > 1`. A node is a PV node exactly when it's
searched with an open window. Inside a null-window search everything is non-PV, so the
"expensive" full-window searches only happen along a single path.

## 3.4 Iterative deepening

Instead of searching to depth 20 directly, the engine searches depth 1, then 2, then 3, …
([`src/search.c:741`](../../src/search.c#L741)). At first sight that's wasteful. In fact
it's faster than searching depth 20 directly, for three reasons:

1. **Time control.** When time runs out, the result of the last *completed* iteration is
   available. A single search to a fixed depth gives no usable answer when it's
   interrupted.
2. **Move ordering.** Every iteration leaves the best move of each visited position in the
   transposition table. The next, deeper iteration tries these moves first, so the
   ordering is nearly perfect, and alpha-beta comes close to its best case. With an
   effective branching factor of 1.5, all earlier iterations together cost only about as
   much as the last one.
3. **Information for time management.** Whether the best move changes between iterations,
   or the score drops, tells the engine whether to think longer (chapter 8).

A refinement at [`src/search.c:775`](../../src/search.c#L775): if an iteration is
interrupted, but a root move has already beaten the previous best with a full search,
that move is used. The partial iteration did find something better, so throwing it away
would be wasteful.

## 3.5 Aspiration windows

From iteration 4 onward, the root isn't searched with the full window `(-∞, +∞)` but with a
narrow window around the previous score ([`src/search.c:751`](../../src/search.c#L751)):

```c
int delta = asp_delta;                       // 17 centipawns, tuned by SPSA
alpha = score - delta;  beta = score + delta;
for (;;) {
    int s = search(t, alpha, beta, depth, 0);
    if (s <= alpha) {                        // fail low: the score dropped
        beta = (alpha + beta) / 2;
        alpha = s - delta;
    } else if (s >= beta) {                  // fail high: the score rose
        beta = s + delta;
    } else break;                            // inside the window: done
    delta += delta / 2;                      // widen and try again
}
```

A narrow window produces more cutoffs, so the search is faster. If the score lies outside,
the search must be repeated with a wider window. That costs time, but rarely, because the
score usually changes by only a few centipawns from one iteration to the next. The
initial window of 17 centipawns was found by SPSA (DEVELOPMENT.md); the hand-picked
value of 20 was close.

## 3.6 The transposition table

Different move orders often lead to the same position (`1.e4 e5 2.Nf3` and
`1.Nf3 e5 2.e4`). Search graphs are full of such **transpositions**. The transposition
table (TT) is a large hash table, keyed by the Zobrist key from chapter 2, that remembers
what was found about each position.

### What an entry stores

[`src/tt.h:8`](../../src/tt.h#L8):

```c
typedef struct {
    uint32_t key32;     // upper 32 bits of the Zobrist key, to verify the position
    Move move;          // best move found (16 bits, chapter 2)
    int16_t score;      // search score (a bound, see below)
    int16_t eval;       // static evaluation, so it need not be computed again
    uint8_t depth;      // search depth + 1 (0 = empty slot)
    uint8_t gen_bound;  // search generation (upper 6 bits) and bound type (lower 2)
} TTEntry;              // 12 bytes

typedef struct {
    TTEntry entries[5];
    char padding[4];
} TTBucket;             // 64 bytes = exactly one cache line
```

A few design decisions packed into these 12 bytes:

* **Five entries per cache line.** A memory access fetches 64 bytes anyway, so one access
  checks five candidates. TT lookups are among the most expensive operations in an
  engine (cache misses), so this layout matters.
* **Only 32 bits of the key are stored.** The lower 32 bits select the bucket, and the upper
  32 bits verify. With millions of entries, a false match (two positions with the same 64-bit
  key) is very rare, and a rare wrong hit is harmless as long as the TT move is checked for
  legality before it is played. That's what `pos_is_pseudo_legal` (chapter 2) is for.
* **Bucket selection by multiplication, not modulo:**
  `((uint32_t)key * bucket_count) >> 32` ([`src/tt.c:33`](../../src/tt.c#L33)). That works
  for any table size, not only powers of two, and avoids the slow division.

### Using an entry: bounds

A stored score is only as good as its bound type (3.1). The probe at the top of `search()`
([`src/search.c:533`](../../src/search.c#L533)):

```c
if (!pv_node && !excluded && hit && tt_depth(tte) >= depth && tt_score != VALUE_NONE &&
    (tt_bound(tte) & (tt_score >= beta ? BOUND_LOWER : BOUND_UPPER)))
    return tt_score;
```

That reads as follows. An earlier search of this position, **at least as deep** as the
current one, gives a cutoff if:

* its score is ≥ beta, and it was a lower bound (or exact): "the position is at least this
  good, which is enough for a beta cutoff"; or
* its score is < beta, and it was an upper bound (or exact): "the position is at most this
  good, which is not enough to beat alpha" (because in a null window, `< beta` means
  `<= alpha`).

`BOUND_EXACT` is `3 = BOUND_LOWER | BOUND_UPPER`, so it satisfies both tests: one bitwise
AND covers all cases.

**Why not in PV nodes?** A TT hit could cut the principal variation short. The engine would
then report a shorter or wrong PV, and worse, it could miss repetitions: the stored score
was computed for a position with a *different history*, perhaps one in which a repetition
draw wasn't available. In non-PV nodes such errors don't matter much; in the PV they can
lose half points. Most strong engines make the same trade-off.

Even when there is no cutoff, the TT entry helps in two ways:

1. **The TT move is searched first.** It was the best move last time, often from the previous
   iteration. This is the most important single source of move ordering (chapter 5).
2. **The stored static eval is reused** (`tte->eval`), so the network doesn't need to be
   evaluated again.

How much the cutoffs alone are worth, measured with a version where only that one `if`
statement is disabled:

| bench | with TT cutoffs | without | more nodes |
|---|---|---|---|
| depth 12 | 1,120,590 | 1,438,498 | +28 % |
| depth 16 | 5,539,501 | 8,268,208 | **+49 %** |

The saving grows with depth, because deeper trees contain more transpositions.

### Mate scores in the TT

[`src/tt.h:38`](../../src/tt.h#L38):

```c
static inline int score_to_tt(int score, int ply) {
    if (score >= VALUE_MATE_IN_MAX) return score + ply;
    if (score <= -VALUE_MATE_IN_MAX) return score - ply;
    return score;
}
```

A mate score includes the distance *from the root*. But a TT entry can be found again at a
different ply, in a later search or by transposition. So the score is converted to "mate in
N plies *from this position*" when it's stored, and back again when it's read. This is a
classic bug in home-grown engines: without the conversion, they announce "mate in 7"
and play a mate in 12, or miss mates altogether.

### Replacement and aging

The table is far too small for every position, so the probe decides which entry in the
bucket gets overwritten ([`src/tt.c:64`](../../src/tt.c#L64)):

```c
// Prefer replacing empty, old and shallow entries.
if ((int)e->depth - 8 * entry_age(e) < (int)replace->depth - 8 * entry_age(replace)) replace = e;
```

* **Depth:** a deep entry represents a lot of work and is kept.
* **Age:** each new search (each move in the game) increases a *generation* counter. An entry
  from an earlier search counts as 8 plies shallower per generation of age, so old knowledge
  makes room for new without the table having to be cleared.

`tt_store` adds one more rule: an existing entry for the *same* position is only
overwritten by a similarly deep or exact result, but its move is always updated, since the
most recent best move is the most useful one.

Finally, [`src/search.c:637`](../../src/search.c#L637) calls `tt_prefetch` right after
making a move. That tells the CPU to fetch the child's bucket from memory while the move
is still being processed, and hides part of the cache-miss latency.

## 3.7 Quiescence search

### The horizon effect

Stop at depth 0 and return `evaluate()`, and you get a famously bad engine. Suppose the
last move of a line was `QxN`, queen takes a defended knight. The position is evaluated as
"a knight up", because the recapture `...PxQ` is beyond the horizon. The engine will now
happily throw its queen at defended pieces, as long as the recapture lands one ply too
far away.

The cure is the **quiescence search** (`qsearch`,
[`src/search.c:411`](../../src/search.c#L411)): at depth 0, the search continues, but only
with **noisy** moves (captures and queen promotions, chapter 2), until the position is
"quiet" and the static evaluation can be trusted.

### Stand pat

The key idea in qsearch is that the side to move is **not forced to capture**. It can
always "stand pat", that is, decline all captures and accept the static evaluation. So the
static eval is a lower bound for the score of the node:

```c
best = corrected_eval(t, raw_eval);   // static eval (+ correction history, chapter 5)
if (best >= beta) return best;        // even without capturing, good enough: cutoff
if (best > alpha) alpha = best;
generate_moves(pos, &list, GEN_NOISY);
```

That also guarantees that qsearch terminates: the captures eventually run out.

**Exception: in check.** A side in check can't stand pat, since it must respond to the
check. Then *all* moves (the evasions) are searched, and if there is none, it's mate
([`src/search.c:490`](../../src/search.c#L490)). Without this rule, qsearch would happily
"stand pat" in positions that are actually lost by mate.

### Pruning captures that can't help

Qsearch can easily grow larger than the main tree, so it is pruned hard
([`src/search.c:460`](../../src/search.c#L460)):

* **SEE pruning:** a capture that loses material according to the static exchange
  evaluation (chapter 2, `see_ge`) is skipped. `QxP` defended by a pawn is not worth
  examining.
* **Delta (futility) pruning:** if even the captured piece plus a safety margin of 145
  centipawns (`qs_fut_margin`, tuned by SPSA) can't lift the score above alpha, the capture
  is pointless:

  ```c
  int futility = futility_base + SEE_VALUE[victim];   // futility_base = stand pat + 145
  if (futility <= alpha) continue;
  ```

  Taking a pawn when you're a rook down won't raise alpha.

### Qsearch and the TT

Qsearch also uses the transposition table, with depth 0. That pays off: the same
capture sequences come up over and over, in different move orders.

## 3.8 Putting it together

Here is the skeleton of `search()` in the order the real code runs. The parts marked
*(ch. 4)* and *(ch. 5)* are covered in the next chapters:

```text
search(alpha, beta, depth, ply):
    if in check: depth += 1                              (check extension, ch. 4)
    if depth <= 0: return qsearch(alpha, beta)
    if draw by repetition / 50 moves / material: return 0
    mate distance pruning
    probe TT  -> cutoff in non-PV nodes if deep enough and the bound fits
    static eval (from TT or network)  + correction    (ch. 5)
    reverse futility, razoring, null move pruning     (ch. 4)
    internal iterative reduction                      (ch. 4)
    for each move from the staged move picker         (ch. 5):
        skip if illegal
        late move pruning, futility, SEE pruning      (ch. 4)
        singular extension                            (ch. 4)
        make move
        PVS + late move reductions                    (3.3 / ch. 4)
        unmake move
        update best / alpha; on beta cutoff: update history tables (ch. 5) and stop
    no legal move: mate or stalemate
    store result in TT (bound: lower / exact / upper)
    update correction history                          (ch. 5)
    return best
```

Everything in this chapter is the foundation that makes these extras safe. Pruning is only
possible because iterative deepening, the TT and good ordering make most moves predictable;
reductions are only safe because PVS re-searches anything that surprises.

## 3.9 Pitfalls that cost home-grown engines Elo

From experience (including the old engine in this repository):

1. **No or broken quiescence search.** The single largest source of blunders in amateur
   engines. Symptom: the engine "wins" material that it immediately loses back.
2. **Mate scores in the TT not adjusted for ply** (3.6). Symptom: wrong mate announcements,
   or a winning position where the engine never delivers mate.
3. **TT cutoffs in PV nodes**, or TT scores used without checking depth or bound. Symptom:
   odd moves now and then, and missed repetition draws.
4. **Using an interrupted iteration's score.** If the search is stopped mid-iteration, the
   values coming back up the tree are garbage. Our search returns `0` from every node once
   `t->stop` is set, and the iteration's result is ignored, except for a root move that had
   already finished its full search (3.4).
5. **Repetitions only counted as threefold inside the tree.** The engine then walks into
   repetitions it can't see as draws, or avoids draws it could have taken. Twofold inside the
   tree is the standard.
6. **Search instability with aspiration windows.** Different windows can produce different
   results for the same position (because of the TT and pruning). Robust code always
   re-searches until the score lies *inside* the window and never trusts a bound as an
   exact score.

## 3.10 Try it yourself

Watch iterative deepening and the effective branching factor:

```
position startpos
go depth 22
```

Each `info depth` line shows the cumulated nodes; dividing consecutive values gives the
branching factor. Try it in a sharp tactical position and in a quiet endgame: the
endgame has a lower branching factor and far more TT hits.

To see a mate score:

```
position fen 6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1
go depth 10
```

(`score mate 1` — back-rank mate with `Rd8#`.)

Exercises, if you like:

* Disable the TT cutoff (put `0 &&` in front of the condition at `search.c:533`) and compare
  `bench 12` and `bench 16`. Why does the difference grow with depth?
* In the aspiration loop, why is `beta` set to `(alpha + beta) / 2` on a fail low, instead of
  being left alone?
* Qsearch skips captures with negative SEE. Find a position where that's wrong, where a
  "losing" capture is actually the best move. (Hint: think of what the capture *uncovers*.)
* Why does `score_to_tt` add `ply` to a positive mate score but subtract it from a negative
  one?

---

**Next:** Chapter 4 — Pruning, reductions and extensions: null move, late move reductions,
futility, singular extensions, and why they are safe.
