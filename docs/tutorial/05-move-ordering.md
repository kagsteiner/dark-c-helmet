# Chapter 5 — Move ordering and history heuristics

> **Files:** [`src/search.c`](../../src/search.c) (lines 155–405: scoring, the staged move
> picker, history updates, correction history)

Chapter 3 said that alpha-beta is only as good as its move ordering, and chapter 4 showed
that most pruning and reductions are *bets on the move ordering*: LMR reduces late moves
because late moves are rarely best; LMP stops after a few quiet moves for the same reason.
If the ordering is bad, these bets lose, and the techniques turn from Elo gains into Elo
losses.

This chapter is about how the engine guesses, before searching anything, which move will
be best. It uses three sources of knowledge:

1. **The transposition table:** what was best here in an earlier search.
2. **Static knowledge:** captures of valuable pieces first; captures that lose material last.
3. **Learned statistics** from the current search: which moves caused cutoffs in similar
   situations (killers, countermoves, history tables).

## 5.1 Measuring move ordering

The standard quality measure: **in what fraction of beta cutoffs was the first move
searched the one that caused it?** For this engine (bench 16, all 18 positions):

| ordering | nodes | first move causes the cutoff | avg. index of the cutoff move |
|---|---|---|---|
| **full ordering** | **5,539,501** | **86.5 %** | **1.31** |
| without the TT move first | 9,188,377 (+66 %) | 83.8 % | 1.37 |
| captures unsorted (no MVV-LVA, no capture history) | 6,591,845 (+19 %) | 78.5 % | 1.44 |
| quiet moves unsorted (no history tables) | 7,430,965 (+34 %) | 86.2 % | 1.47 |
| without killers and countermoves | 5,121,957 (−8 %) | 85.8 % | 1.34 |

The order of magnitude to aim for: 85–95 % first-move cutoffs is typical for strong
engines; a simple engine with MVV-LVA only is often around 70 %.

The last line is a surprise. More on that in 5.5.

## 5.2 The order in which moves are tried

The engine produces moves lazily, in stages, with a **staged move picker**
([`src/search.c:229`](../../src/search.c#L229)):

```c
enum {
    STAGE_TT,           // 1. the hash move, before anything is generated
    STAGE_GEN_NOISY,    //    generate captures + queen promotions, score them
    STAGE_GOOD_NOISY,   // 2. captures that don't lose material (SEE >= 0), best first
    STAGE_KILLER1,      // 3. killer moves of this ply
    STAGE_KILLER2,
    STAGE_COUNTER,      // 4. the countermove to the opponent's last move
    STAGE_GEN_QUIET,    //    generate quiet moves, score them by history
    STAGE_QUIET,        // 5. quiet moves, best history first
    STAGE_BAD_NOISY,    // 6. captures that lose material (SEE < 0)
    STAGE_DONE
};
```

Each stage is a small piece of chess wisdom:

1. **Hash move:** the best move from the last time this position was searched. It causes
   the cutoff more often than everything else together.
2. **Good captures:** winning material is usually good. Captures are sorted by the victim's
   value first, then (ties) by the attacker (MVV-LVA, 5.3).
3. **Killers:** quiet moves that recently caused cutoffs at the same ply (5.5).
4. **Countermove:** the quiet move that last refuted the opponent's previous move (5.5).
5. **Remaining quiet moves,** by the history tables (5.6).
6. **Losing captures** come last: `QxP` defended by a pawn is usually bad, but sometimes
   a sacrifice, so it's searched, just late.

**Why stages instead of one sorted list?** The old way was: generate all moves, score all of
them, sort, search. But in a cut node, the hash move or the first capture usually causes the
cutoff, and then generating and scoring the quiet moves was wasted. The staged picker:

* tries the hash move **before generating anything** (after validating it with
  `pos_is_pseudo_legal`, chapter 2, because a TT entry can belong to a different position);
* generates quiet moves only when the captures haven't produced a cutoff;
* computes the expensive SEE only for captures that are actually picked.

When this was introduced it was worth **+45 Elo**, and **39 % more nodes per second**
(DEVELOPMENT.md). The tree didn't change much; the engine just stopped doing work it
didn't need.

## 5.3 Captures: MVV-LVA, SEE and capture history

[`src/search.c:271`](../../src/search.c#L271):

```c
int value = SEE_VALUE[victim] + (promotion ? SEE_VALUE[QUEEN] : 0);
int hist  = capture_history[moving piece][to square][victim type] / 16;
score = value * 16 - attacker type + hist;
```

* **MVV-LVA** ("most valuable victim, least valuable attacker"): capture the queen before
  the pawn; among captures of the same piece, capture with the pawn before the queen.
  `value * 16` makes the victim dominate; `- attacker type` breaks ties.
* **Capture history** fine-tunes within that: a table indexed by
  *(moving piece, target square, captured piece type)* that learns which captures caused
  cutoffs in this search. `RxN on e5` that worked several times moves ahead of `BxN on c3`.
  Worth +3.5 Elo, small, but measurable.
* **SEE splits good from bad**: when a capture is picked in the good-capture stage, `see_ge`
  checks whether it loses material. If so, it's moved to the "bad" list, searched after the
  quiet moves.

## 5.4 Learning from cutoffs: the bonus formula

All history tables learn the same way. When a quiet move causes a beta cutoff, it gets a
bonus, and **every quiet move that was searched before it and failed gets a malus**
([`src/search.c:353`](../../src/search.c#L353)):

```c
int bonus = min(depth * depth * 18, 1623);
for (each quiet move tried in this node) {
    int b = (m == best) ? bonus : -bonus;
    history_update(&history[side][from][to], b);
    history_update(&(*ss[-1].cont)[piece][to], b);   // continuation history, 1 ply back
    history_update(&(*ss[-2].cont)[piece][to], b);   // continuation history, 2 plies back
}
```

`depth²` weighting: a cutoff in a deep search proves more than one at depth 1. The cap keeps
single events from dominating.

The update itself is a small but important detail ([`src/search.c:349`](../../src/search.c#L349)):

```c
static inline void history_update(int* entry, int bonus) {
    *entry += bonus - *entry * abs(bonus) / HISTORY_MAX;     // HISTORY_MAX = 16384
}
```

This is called **history gravity**. Without the second term, history values grow without
limit, and old knowledge outweighs new. With it, an entry converges towards ±16384: the
closer it already is, the smaller the step. It behaves like an exponential moving average.
Values stay bounded, and recent experience counts more than old.

The malus for failed moves is just as important as the bonus. Without it, a move that is
tried often (because it's always near the front) collects bonuses from its occasional
successes, even if it fails most of the time.

## 5.5 Killers and countermoves

**Killer moves** ([`src/search.c:359`](../../src/search.c#L359)): the last two quiet moves
that caused a cutoff *at the same ply* (in sibling nodes). The idea, from the 1970s: if
`Ng5` refutes one of the opponent's moves, it probably refutes many of them, because the
refutation is often independent of what the opponent just did (a threat, a mating pattern).

**Countermoves** ([`src/search.c:363`](../../src/search.c#L363)): for each opponent move
(piece, target square), the quiet move that last refuted it. A natural response to a
specific move.

Both are tried right after the good captures, before the other quiet moves.

**And now the surprise from 5.1:** removing killers and countermoves made the tree at
bench 16 *smaller* (−8 %). Why? Both ideas predate the history tables, and
**continuation history (5.6) captures the same knowledge, but better**: "after the
opponent's `Bb5`, the move `a6` is good" is exactly what the 1-ply continuation history
stores, and it's not limited to one move per situation. So the killers are now mostly
redundant, and they push moves to the front that the history ranks lower.

Whether they cost *strength* is a different question, because fixed-depth node counts aren't
Elo (pruning depends on the move order, too). A 600-game test answers it:

| | Elo vs full engine (600 games) |
|---|---|
| without killers and countermoves | −9.9 ± 13.7 |

So despite the smaller tree, removing them probably costs a few Elo, but the result isn't
significant: the 95 % interval runs from −24 to +4. Killers and countermoves remain, but
they're clearly no longer the big win they were in the 1980s. Most of their job has moved to
the continuation history. And it's a perfect example for pitfall 5 below: the node count
said "remove them", the games say "keep them, probably".

## 5.6 History tables

All remaining quiet moves are sorted by a combined history score
([`src/search.c:167`](../../src/search.c#L167)):

```c
static inline int quiet_history(SearchThread* t, const StackEntry* ss, int side, int piece, Move m) {
    int to = move_to(m);
    return t->history[side][move_from(m)][to]   // butterfly history
         + (*ss[-1].cont)[piece][to]            // continuation history, after the opponent's move
         + (*ss[-2].cont)[piece][to];           // continuation history, after our own previous move
}
```

* **Butterfly history** `[side][from][to]`: the classic. "Moving from e2 to e4 has been
  good for White in this search." It ignores context completely, but learns fast.
* **Continuation history** `[previous piece][previous to][piece][to]`: "a knight move to f5
  is good **after the opponent's queen went to d7**." That's context: the move is judged
  as an answer to a specific previous move. Our engine uses two of these: one indexed by the
  opponent's last move (1 ply back), one by our own previous move (2 plies back, "follow-up
  history": a plan of two moves).

The `ss[-1].cont` pointer in the search stack points to the table for the previous move, so
the lookup costs no extra computation. After a null move, it points to a "sentinel" table
that is never updated, so that a pass doesn't teach anything.

Continuation history was worth **+25 to +37 Elo** when it was added (DEVELOPMENT.md), one of
the bigger single gains in this engine's history.

**History is kept between moves of a game.** The positions in the next search are similar,
so the knowledge transfers. It's cleared on `ucinewgame`.

## 5.7 How history feeds into pruning and reductions

Move ordering isn't the only use of history. Chapter 4 already showed:

* **LMR** (4.8): `r -= hist / lmr_hist_div` (14939). A quiet move with history +15000 is
  reduced one ply less, one with −15000 one ply more.
* **LMP** (4.7) works only because the quiet moves are *sorted by history*: the moves that
  are pruned are those with the worst history.

So history does double duty: it orders, and it measures how promising a move is. In
modern engines, more and more pruning decisions use it.

## 5.8 Correction history: learning where the eval is wrong

The last table isn't about moves, but it learns from the search the same way, so it fits
here. **Correction history** learns how wrong the static evaluation tends to be for a given
**pawn structure** ([`src/search.c:389`](../../src/search.c#L389)):

```c
// Static evaluation adjusted by the learned correction for this pawn structure.
int corrected_eval(int raw) { return raw + correction[side][pawn_key % 16384] / 256; }
```

After each node, the difference between what the search found and what the static eval
predicted moves the correction ([`src/search.c:694`](../../src/search.c#L694)):

```c
// only from quiet positions where the score says something about the eval:
// a fail-high above it, a fail-low below it, or an exact score
if (!checked && best_move is quiet && no mate score && bound is consistent)
    update_correction(t, depth, best - ss->static_eval);
```

`update_correction` is again a moving average, weighted by depth (deeper searches count
more), stored with 8 extra bits of precision (`CORR_GRAIN` 256) and clamped to ±64
centipawns.

**Why pawn structure?** The pawn structure changes rarely, so it identifies a "type of
position" that recurs thousands of times in a search, and many systematic eval errors are
about pawns: a passed pawn that's stronger than the net thinks, a blocked structure that's
more drawish. The corrected eval is used everywhere the static eval is: in pruning
decisions (chapter 4) and as the stand-pat score in qsearch (chapter 3). It was worth
**+10.5 Elo**.

The idea is relatively new in computer chess (a few years old) and is one of the cleverer
ones: the search is used to correct the evaluation online, for the specific game being
played.

## 5.9 Pitfalls

1. **Not validating the hash move.** A TT entry can belong to a different position (key
   collision) or be corrupted by another thread (Lazy SMP, chapter 8). Playing an illegal
   hash move crashes the engine or corrupts the board. `pos_is_pseudo_legal` is cheap
   insurance.
2. **History without gravity or malus.** The values saturate or overflow, and the ordering
   gets worse the longer the game runs.
3. **Searching a move twice.** The hash move, killers and countermove also come out of the
   generator. Forgetting to skip them in the quiet stage means searching them twice, which
   costs time and corrupts history.
4. **Updating history from null moves or pruned moves.** Only moves that were actually
   *searched* and failed get the malus. A pruned move hasn't proven anything.
5. **Judging ordering by node counts alone.** 5.5 shows why: fewer nodes at fixed depth
   doesn't automatically mean more Elo, because pruning depends on the order too.

## 5.10 Try it yourself

Exercises, if you like:

* Why is the bonus `depth²` rather than `depth`? What would happen at the leaves with a
  constant bonus?
* Continuation history uses `[previous piece][previous to][piece][to]`: 12 × 64 × 12 × 64
  ≈ 590,000 entries per table. Why `piece` and `to` instead of `from` and `to`?
* In the staged picker, the losing captures come *after* the quiet moves. In qsearch they're
  not searched at all. Why the difference?
* The correction history uses only the pawn structure. Which other "keys" could identify a
  recurring type of position? (Strong engines use several correction tables with different
  keys.)

---

**Next:** Chapter 6 — Classical evaluation and Texel tuning: what the engine knew before NNUE,
and how its parameters were fitted to millions of positions.
