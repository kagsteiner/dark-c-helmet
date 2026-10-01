# Chapter 4 — Pruning, reductions and extensions

> **Files:** [`src/search.c`](../../src/search.c) (lines 497–700), [`src/tune.h`](../../src/tune.h)
> (the tuned constants)

Chapter 3 built a correct alpha-beta search. A correct alpha-beta search with good move
ordering reaches maybe depth 8–10 in a second. This engine reaches 20+. The difference
is this chapter: a dozen techniques that decide, at each node, **how much effort it
deserves**.

There are three kinds of decisions:

* **Pruning:** don't search a move or a node at all (null move pruning, reverse futility
  pruning, razoring, late move pruning, futility pruning, SEE pruning).
* **Reductions:** search a move, but less deeply (late move reductions, internal iterative
  reduction).
* **Extensions:** search a move *more* deeply than normal (check extension, singular
  extension).

All of them are **heuristics**. Each one makes the search wrong in some positions: it
prunes a move that would have been brilliant, or reduces the line that contained the
refutation. They pay off because they're right far more often than wrong, and the time
saved buys depth everywhere else. Which brings us to the most important lesson of this
chapter: **nobody can tell by thinking whether a pruning rule is good.** You can only
measure it. Every rule here was tested with SPRT, and all thresholds were tuned with SPSA
(chapter 8).

## 4.1 What each technique is worth here

Before the details, here are the measurements. For each technique, an engine with exactly
that technique switched off (a single `if (0 && …)`) played 600 games against the full
engine, build 69, at 8 s + 0.08 s per game. The middle column shows how the tree size at
fixed depth (bench 12) changes without the technique.

<!-- ABLATION-TABLE -->

How to read this:

* **Pruning techniques make the tree smaller** at the same depth. Without them, the engine
  is slower to reach each depth and searches less deeply in the same time.
* **Extensions make the tree *larger*** at the same depth. Without singular and check
  extensions, the bench tree shrinks to 61 % and 69 % of its size. They cost nodes and
  still win Elo, because they put the extra effort exactly where it matters.
* **Fixed-depth node counts aren't strength.** Only the games decide. The ±values are 95 %
  confidence intervals, and 600 games can't resolve differences of a few Elo.

## 4.2 Preparation: static eval, `improving`, PV nodes

Almost all pruning decisions compare the **static evaluation** of the current node with
alpha or beta. So `search()` computes it first ([`src/search.c:538`](../../src/search.c#L538)):

```c
raw_eval = (hit && tte->eval != VALUE_NONE) ? tte->eval : evaluate(pos);
ss->static_eval = eval = corrected_eval(t, raw_eval);      // + correction history (ch. 5)
if (tt_score != VALUE_NONE && (tt_bound(tte) & (tt_score > eval ? BOUND_LOWER : BOUND_UPPER)))
    eval = tt_score;                                        // a TT score is better than a guess
if (ply >= 2 && ss[-2].static_eval != VALUE_NONE) improving = ss->static_eval > ss[-2].static_eval;
```

Two details matter:

1. **A usable TT score replaces the static eval** for pruning purposes. If an earlier search
   proved "this position is at least +250", that's more reliable than the network's
   static guess.
2. **`improving`**: is our position better than it was two plies ago (our previous move)?
   If yes, we're probably on a good path, and pruning should be more cautious. If not,
   the line is probably bad, and pruning can be more aggressive. It's a crude signal, but
   it appears in almost every rule below.

And a principle that applies to everything: **no pruning in PV nodes, and none when in
check.** PV nodes are few and decide the result; in check, the static eval means little.

## 4.3 Reverse futility pruning (RFP)

[`src/search.c:554`](../../src/search.c#L554):

```c
if (depth <= rfp_depth && eval - rfp_margin * (depth - improving) >= beta && eval < VALUE_MATE_IN_MAX)
    return eval;
```

**Idea:** if the static eval is already far above beta, so far that even the opponent's
best reply within the remaining depth is unlikely to bring it back, give up searching and
return. `rfp_margin` is 77 centipawns per ply of remaining depth: at depth 3, the eval must
be 231 above beta (154 if `improving`).

This is also called "static null move pruning": like the null move (4.5), it bets that our
position is so good that we'd still be above beta even after "passing". But here we don't
even search to check.

RFP is cheap and very effective at low depth, where most of the tree is. At depth > 8 it is
switched off: there the margin would be so large that it rarely applies, and errors would
be expensive.

## 4.4 Razoring

[`src/search.c:557`](../../src/search.c#L557):

```c
if (depth <= 3 && eval + razor_margin * depth <= alpha) {
    int score = qsearch(t, alpha, beta, ply);
    if (score <= alpha) return score;
}
```

The mirror image of RFP: if the static eval is far *below* alpha (268 centipawns per ply),
ask the quiescence search whether a capture changes that. If not, the node is hopeless
at shallow depth: no quiet move will make up for a rook. Unlike RFP, it checks with
qsearch first, because a bad static eval can be wrong if a big capture is available.

In this engine razoring brings little (4.1): RFP, futility and late move pruning already
cover most of these positions. Many strong engines have it anyway, with small margins.

## 4.5 Null move pruning (NMP)

[`src/search.c:563`](../../src/search.c#L563):

```c
if (depth >= 3 && eval >= beta && ss->static_eval >= beta && ss[-1].move != MOVE_NONE &&
    non_pawn_material(pos, pos->side) && beta > -VALUE_MATE_IN_MAX) {
    int r = nmp_base + depth / nmp_depth_div + min((eval - beta) / nmp_eval_div, 3);
    pos_make_null(pos);                                     // side to move passes
    int score = -search(t, -beta, -beta + 1, depth - r, ply + 1);
    pos_unmake_null(pos);
    if (score >= beta) return score >= VALUE_MATE_IN_MAX ? beta : score;
}
```

**Idea:** in almost every chess position, having the move is an advantage. If we *pass*
(make a "null move") and the opponent, with a free extra move, still can't push the score
below beta, then our position is so strong that a real move would certainly reach beta too.
Since that's only a check, the reduced search is enough: `r` = 3 + depth/3 + up to 3 more
if the eval is far above beta. At depth 12, the null-move search runs at depth 5 or less.

That's dramatically cheaper than searching 30 moves. NMP is one of the oldest and most
effective techniques in computer chess.

The conditions protect against the cases where the assumption "the move is an advantage"
is wrong:

* **`non_pawn_material`:** in pure pawn endgames, **zugzwang** is common: the side to move
  would *prefer* to pass. There, the null move gives completely wrong results, so it's
  off.
* **`ss[-1].move != MOVE_NONE`:** no two null moves in a row (that would be the same position
  again, but shallower).
* **`beta > -VALUE_MATE_IN_MAX`, and a mate score is returned as `beta`:** null-move
  results don't prove mates. The opponent's mate threat could be avoidable by a real move.
* **Not in check:** passing while in check is illegal.

The `ss->move = MOVE_NONE` and `cont = &cont_sentinel` lines before the null move (in the
real code) make sure the history tables of chapter 5 don't learn anything from a pass.

## 4.6 Internal iterative reduction (IIR)

[`src/search.c:578`](../../src/search.c#L578):

```c
if (depth >= iir_depth && tt_move == MOVE_NONE && !root) depth--;
```

A node without a TT move at depth ≥ 5 has never been searched deeply before. It's off
the main line, and move ordering will be poor because the most important ordering source
is missing. Older engines did a full extra search at reduced depth just to find a good
first move ("internal iterative deepening"). Modern engines simply reduce the depth by one.
That's simpler and measurably better. The next time this node comes up, it will have a TT
move.

## 4.7 Move-loop pruning: LMP, futility, SEE

Inside the move loop, three rules skip individual moves
([`src/search.c:598`](../../src/search.c#L598)). They only apply once a real score has been
found (`best > -VALUE_MATE_IN_MAX`), so the engine never prunes its way into "no moves
searched, so it's mate".

### Late move pruning (LMP)

```c
if (depth <= 8 && legal > (lmp_base + depth * depth) / (2 - improving)) { skip_quiets = 1; continue; }
```

Thanks to move ordering, if the hash move, the good captures, the killers and the first
quiet moves (sorted by history) haven't raised alpha, the remaining quiet moves almost
certainly won't either. At depth 1, after 2 legal moves (5 if improving), the rest of the
quiet moves are skipped; at depth 4, after 10 (20). `skip_quiets` also tells the move
picker (chapter 5) to stop *generating* quiet moves, which saves even more time.

### Futility pruning

```c
if (!checked && depth <= 8 && ss->static_eval + fut_base + fut_mult * depth <= alpha) { skip_quiets = 1; continue; }
```

Like RFP, but per move: if the static eval plus an optimistic margin (101 + 98 per ply) is
still below alpha, a quiet move won't reach it either. Captures are still tried, because
they can change the material balance.

### SEE pruning

```c
if (quiet) { if (depth <= 8 && !see_ge(pos, m, -see_quiet * depth)) continue; }   // 46 per ply
else       { if (depth <= 8 && !see_ge(pos, m, -see_noisy * depth)) continue; }   // 99 per ply
```

Moves that lose material according to the static exchange evaluation (chapter 2) are skipped
at low depth. The threshold grows with depth: at depth 1, a quiet move that puts a piece
where it loses 46 centipawns or more is skipped; at depth 6, only losses beyond 276.
Captures get a bigger allowance, because sacrifices are more often deliberate there.

## 4.8 Late move reductions (LMR)

LMR is the technique with the biggest effect in modern engines (4.1). The idea (we touched
on it in chapter 3): with good move ordering, the best move is almost always among the
first few. The later a quiet move comes in the order, the less likely it is to matter, so
it's searched *less deeply*, first with a null window. Only if it surprises, by beating
alpha, is it searched again at full depth.

[`src/search.c:642`](../../src/search.c#L642):

```c
if (depth >= 3 && legal > 1 + pv_node && quiet) {
    int r = lmr_table[depth][legal];
    r -= pv_node;                                         // PV node: reduce less
    r += !improving;                                      // getting worse: reduce more
    r -= gives_check;                                     // checks: reduce less
    r -= (m == ss->killers[0] || m == ss->killers[1]);    // killer moves: reduce less
    r -= hist / lmr_hist_div;                             // good history: reduce less, bad: more
    r = clamp(r, 0, new_depth - 1);
    score = -search(t, -alpha - 1, -alpha, new_depth - r, ply + 1);
    if (score > alpha && r > 0) score = -search(t, -alpha - 1, -alpha, new_depth, ply + 1);
}
```

The base reduction comes from a table ([`src/search.c:90`](../../src/search.c#L90)):

```c
lmr_table[d][m] = (int)(0.72 + log(d) * log(m) / 2.27);
```

| depth \ move number | 2 | 4 | 8 | 16 | 32 |
|---|---|---|---|---|---|
| 3 | 1 | 1 | 1 | 2 | 2 |
| 6 | 1 | 1 | 2 | 2 | 3 |
| 10 | 1 | 2 | 2 | 3 | 4 |
| 20 | 1 | 2 | 3 | 4 | 5 |

The `log × log` form is a de-facto standard: the reduction grows with both depth and move
number, but slowly. The two constants were tuned by SPSA (0.75 → 0.72, 2.25 → 2.27).

What makes LMR so effective is that its mistakes **correct themselves**. If a reduced
move turns out to be good, the re-search at full depth finds that out. The only real cost
is a move whose true value only shows at full depth but which already looks bad at reduced
depth. That's rare, and on the next iteration (one ply deeper) the reduced search is also
deeper.

The adjustments use everything the engine knows about the move:

* **History** (chapter 5) is the most important adjustment: a quiet move that caused
  cutoffs in similar situations is reduced less, and one that never worked is reduced
  more.
* **Checks** and **killers** are reduced less, because they're more often relevant.
* **`!improving`** increases the reduction: in a deteriorating position, the moves are less
  promising anyway.

This is where most of the "finer LMR rules" from the improvement list in DEVELOPMENT.md
would go: reducing captures as well, using the TT bound, measuring in fractions of a ply,
and so on.

## 4.9 Extensions

Pruning and reductions save effort. Extensions spend more effort where a line is
*critical*, so that the horizon doesn't hide what matters most.

### Check extension

[`src/search.c:506`](../../src/search.c#L506):

```c
if (checked && depth < MAX_PLY) depth++;
```

A position in check is searched one ply deeper. Checks are forcing (the opponent's
reply options are limited), the tree stays small, and many tactical sequences consist of
checks. Without the extension, a mating attack can easily vanish behind the horizon.

### Singular extensions

[`src/search.c:618`](../../src/search.c#L618), the most interesting technique in this
chapter and worth +26 Elo when it was added (DEVELOPMENT.md):

```c
if (!root && m == tt_move && !excluded && depth >= se_depth && hit && tt_depth(tte) >= depth - 3 &&
    (tt_bound(tte) & BOUND_LOWER) && abs(tt_score) < VALUE_MATE_IN_MAX && ply < 2 * t->root_depth) {
    int singular_beta = tt_score - se_margin * depth / 16;      // ~2 cp per ply below the TT score
    ss->excluded = m;
    int s = search(t, singular_beta - 1, singular_beta, (depth - 1) / 2, ply);   // all moves BUT m
    ss->excluded = MOVE_NONE;
    if (s < singular_beta) extension = 1;                       // m is "singular": extend it
    else if (singular_beta >= beta) return singular_beta;       // multi-cut
    else if (tt_score >= beta) extension = -1;                  // negative extension
}
```

**Idea:** the TT says move `m` is good (it scored at least `tt_score`). Is it the *only*
good move? To find out, the same position is searched at half depth, with `m` excluded
and a null window just below the TT score. Three outcomes:

1. **All other moves fail low:** `m` is *singular*, the only move that holds the position.
   Forced lines like that are where engines go wrong when the horizon cuts them off, so
   `m` gets an extra ply.
2. **Another move also reaches `singular_beta`, and that's already ≥ beta:** at least two
   moves beat beta. This node will almost certainly cut off whatever happens, so it returns
   immediately (**multi-cut**).
3. **Others are almost as good, and the TT score is ≥ beta:** `m` isn't special, and there
   are alternatives. Its depth is *reduced* by one (**negative extension**). This was part of
   the original SPRT and helps to save effort.

The conditions make sure the verification search is worth its price:

* Only at depth ≥ 8, where the extension matters and the verification search is cheap
  relative to the node.
* The TT entry must be deep enough (`depth - 3`) and a lower bound: we need a real claim
  "`m` is at least this good".
* `ply < 2 * root_depth` limits the total number of extensions per line, so that a long
  sequence of singular moves can't make the search explode.

The `excluded` mechanism needs care in the rest of `search()`: with an excluded move,
there are no TT cutoffs and no TT stores, and if no move is left, it returns alpha instead
of "mate". Otherwise the exclusion search would pollute the TT with results for "the
position minus one move".

## 4.10 How it all fits together

Seen from a distance, the search treats nodes like a triage:

| situation | treatment |
|---|---|
| clearly winning (eval ≫ beta) | RFP returns immediately; NMP proves it with a cheap search |
| clearly losing (eval ≪ alpha) | razoring, futility pruning skip the quiet moves |
| unknown node, no TT move | IIR: one ply less |
| typical cut / all node | LMR reduces most moves; LMP stops after a few quiet moves |
| forced line (check, singular move) | extended |
| PV node | searched almost fully: no node pruning, smaller reductions |

The result is a **highly unbalanced tree**. The main line and the critical alternatives are
searched deeply. The bulk of "obviously bad" lines is cut off after 1–3 plies. That's how
the engine reaches nominal depth 20 from the start position with a **selective depth** of
27 plies (`seldepth` in the `info` output: the longest line actually examined, including
extensions and qsearch).

## 4.11 Pitfalls

1. **Pruning without a secured score.** Pruning everything in a node can leave
   `best = -INF`, which is then reported as "mate". The `best > -VALUE_MATE_IN_MAX`
   condition in the move loop prevents it.
2. **Null move in zugzwang positions.** Pawn endgames without the material condition are
   the classic. Symptom: the engine misevaluates simple pawn endgames.
3. **Mate scores from reduced or pruned searches.** A null-move search "proving" a mate,
   or RFP returning a mate score, can produce phantom mates. All the rules above exclude
   mate scores.
4. **LMR without a re-search.** Then a good late move is simply lost. The re-search is what
   turns the reduction from "pruning" into "reduced effort until proven otherwise".
5. **Untested margins.** Every constant in this chapter came from a hand-picked guess and
   was later moved by SPSA (`src/tune.h`). Guesses are usually in the right range, but
   rarely optimal: the first SPSA run was worth +20 Elo without adding a single new idea.
6. **Combining techniques without re-measuring.** Techniques overlap: razoring is worth
   little here because RFP and futility already cover its cases. A rule that was +10 Elo
   in an engine without RFP can be +0 in one with it. Only measuring helps.

## 4.12 Try it yourself

Compare the two `info` fields `depth` and `seldepth`:

```
position startpos
go depth 20
```

Exercises, if you like:

* RFP uses `eval` (which can be the TT score), but futility pruning uses `ss->static_eval`.
  Why might that difference be deliberate?
* Null move pruning is off in pawn endgames. Construct a position with pieces in which
  zugzwang still occurs. Would NMP misjudge it? (Hint: the reduced search after the null
  move *also* uses NMP at its nodes, but not twice in a row.)
* Why is the singular-extension verification search done with `ss->excluded = m` at the
  *same* ply, instead of by making each other move?
* In the LMR code, `r` is clamped to at most `new_depth - 1`. What would happen without that?

---

**Next:** Chapter 5 — Move ordering and history heuristics: the hash move, MVV-LVA and
capture history, killers and countermoves, butterfly and continuation history, correction
history, and the staged move picker.
