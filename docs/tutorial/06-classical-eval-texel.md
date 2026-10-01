# Chapter 6 — Classical evaluation and Texel tuning

> **Files:** [`src/eval.h`](../../src/eval.h), [`src/eval.c`](../../src/eval.c),
> [`tools/tune/tuner.c`](../../tools/tune/tuner.c), [`tools/tune/apply_params.py`](../../tools/tune/apply_params.py)

Today, Dark C. Helmet evaluates positions with a neural network (chapter 7). But the
engine started with a hand-crafted evaluation, and it's still in the code: without a
network, or with `setoption name UseNNUE value false`, the engine uses it. There are good
reasons to understand it:

* It's the evaluation most home-grown engines have, probably including yours. Knowing
  what a *good* classical eval contains, and how far tuning alone takes it, explains a large
  part of the gap between 2100 and 2800.
* The **tuning method** (Texel tuning) is the bridge to NNUE. A neural network is, in the end,
  the same idea taken further: fit an evaluation function to the results of millions of
  positions.
* It was worth measuring: tuning the hand-crafted weights brought **+104 Elo**. Then the first
  small neural network (26M positions) beat the tuned version by **+217 Elo**. Both
  numbers say something about what evaluation can and can't do.

## 6.1 Middlegame and endgame: tapered evaluation

A king in the centre is a liability in the middlegame and an asset in the endgame. A passed
pawn on the 6th rank is worth more the fewer pieces are left. Most evaluation terms need two
values: one for the middlegame (mg), one for the endgame (eg). The engine blends them by
**game phase** ([`src/eval.c:456`](../../src/eval.c#L456)):

```c
int phase = min(pos->st->phase, 24);     // 24 = all pieces on the board, 0 = only pawns and kings
int v = (mg * phase + eg * (24 - phase) * scale / 128) / 24;
```

The phase counts the remaining pieces: knight and bishop 1, rook 2, queen 4
([`src/position.c:15`](../../src/position.c#L15)), so the starting position has 4 + 4 + 8 + 8
= 24. Every term is interpolated smoothly between the two phases, so there are no jumps
in the eval when a piece is traded. Older engines often switched between "middlegame mode"
and "endgame mode" at some threshold, and played strangely around the threshold.

### Two numbers in one int

[`src/eval.h:8`](../../src/eval.h#L8):

```c
typedef int Score;
#define MAKE_SCORE(mg, eg) ((int)((unsigned int)(eg) << 16) + (mg))
static inline int mg_value(Score s) { return (int16_t)(uint16_t)(unsigned int)s; }
static inline int eg_value(Score s) { return (int16_t)(uint16_t)((unsigned int)(s + 0x8000) >> 16); }
```

A small trick from Stockfish: the eg value lives in the upper 16 bits, the mg value in the
lower 16. Adding two Scores adds both halves at once, as long as no half overflows, and
multiplying by a small integer works too. The `+ 0x8000` in `eg_value` corrects the borrow
when the mg half is negative. The evaluation code can then write `score += P.passed_pawn[r]`
once instead of twice. In the source, `S(mg, eg)` is the short form.

## 6.2 Material and piece-square tables

The biggest and simplest part: what each piece is worth, and how much better or worse each
square is for it ([`src/eval.c:16`](../../src/eval.c#L16)). For example, the tuned knight
table (from White's view, rank 1 at the top):

```
S(-106,-29) S(-19,-48) S(-55,-21) ...     a knight on a1 is bad, especially in the middlegame
...
S(-7,-17)   S(13,2)    S(21,26)   S(46,19) S(32,18) S(60,10) ...   strong central squares on rank 5
```

Material + piece-square values together are kept **incrementally**: chapter 2's make-move
adds and subtracts the values of moved pieces (`st->psq_mg`, `st->psq_eg`), so the evaluation
gets them for free. `eval_init()` merges material and table into one combined table per piece
and colour.

The starting values were **PeSTO's** tables (by Ronald Friederich), a well-known public set that
was itself tuned. They're a good start; our tuning moved them further for our engine and our
other eval terms.

## 6.3 The other terms

Material and tables say nothing about how pieces interact. That's the job of the remaining
roughly 150 terms, grouped like this:

**Pawn structure** ([`src/eval.c:162`](../../src/eval.c#L162)): doubled, isolated, backward,
passed (by rank), connected (defended or side by side, by rank). The pawn structure changes
rarely, so its score is cached in a **pawn hash table** keyed by the pawn Zobrist key: most
evaluations find the result there. (The pawn key returns in chapter 5, as the index of the
correction history.)

**Pieces** ([`src/eval.c:244`](../../src/eval.c#L244)):
* **Mobility**, by piece type and number of reachable squares, but only counting squares in
  the *mobility area*: not occupied by own pawns or king, not attacked by enemy pawns. A
  bishop "attacking" 8 squares, 6 of them covered by pawns, isn't mobile. Pinned pieces only
  count moves along the pin line.
* **Outposts:** a knight or bishop on ranks 4–6, defended by a pawn, that no enemy pawn
  can ever attack.
* **Rooks** on open and semi-open files.
* **Bishop pair.**

**King safety** ([`src/eval.c:293`](../../src/eval.c#L293)):
* Pawn shield in front of the king, and open files next to it.
* Attacks on the **king zone** (the king's square and its neighbours), by attacker type.
* **Safe checks:** squares from which an enemy piece could give check without being
  captured. One of the strongest king-safety signals there is.

**Passed pawns** ([`src/eval.c:330`](../../src/eval.c#L330)): distance of both kings to the
square in front of the pawn (by rank), and whether that square is blocked. This captures
endgame races without computing them: a passed pawn whose stop square is far from the
enemy king is dangerous.

**Threats** ([`src/eval.c:353`](../../src/eval.c#L353)): pieces attacked by lower-value
pieces (pawn attacks a knight, minor piece attacks a rook), and **hanging** pieces (attacked
and not defended).

**Endgame scaling** ([`src/eval.c:383`](../../src/eval.c#L383)): some endgames are drawish
even with a material advantage. Without pawns and with at most a minor piece more, the
strong side can rarely win (the eg score is scaled to 0 or 1/8). Opposite-coloured bishops
without other pieces: halved.

**Tempo:** a small bonus for the side to move.

In total, `EvalParams` contains **539 Scores**, so 1,078 numbers. Choosing them by hand is
hopeless, which brings us to tuning.

## 6.4 Texel tuning: the idea

In 2014, Peter Österlund (author of the engine Texel) described a method that changed
amateur engine development: **fit the evaluation weights to game results.**

1. Collect millions of positions from games, each with the game's result: 1 (White won),
   ½ (draw), 0 (Black won).
2. Turn the evaluation into a predicted win probability with a sigmoid:
   `p = 1 / (1 + 10^(-K · eval / 400))`.
3. Adjust all weights so that the mean squared error between `p` and the actual results is
   as small as possible.

Positions from games that White won should get a positive eval, those from lost games a
negative one, and the size of the eval should match how often such positions are actually
won. It's simply logistic regression on chess positions. The method doesn't need anyone
to know what a "good" weight is: the data decides.

## 6.5 Texel tuning: the implementation

The tuner ([`tools/tune/tuner.c`](../../tools/tune/tuner.c)) uses a trick that makes it fast.
Apart from the phase blending and the endgame scaling, the evaluation is **linear in its
weights**: it's a sum of `weight × count` terms. For example, "2 isolated pawns for White,
1 for Black" contributes `(2 − 1) × isolated_pawn`.

So the engine's `evaluate()` runs once per position in a special build (`-DTUNE`) that
records, instead of just the result, **how often each weight was used** for each side: the
**trace** (`TRACE` macro, [`src/eval.c:131`](../../src/eval.c#L131)):

```c
if (FORWARD_FILE_BB[us][sq] & ours) {
    score += P.doubled_pawn;
    TRACE(P.doubled_pawn, us, 1);      // in a tuner build: count it
}
```

From then on, evaluating a position with new weights is only a dot product over its ~28
non-zero coefficients. No board, no move generation:

```c
static inline double linear_eval(const Sample* s) {
    double mg = 0, eg = 0;
    for (each traced coefficient c of weight i) { mg += c * weights[i][0]; eg += c * weights[i][1]; }
    return (mg * s->phase + eg * (24 - s->phase) * s->scale / 128.0) / 24.0;
}
```

The rest is straightforward machine learning:

1. **Verification:** the linear model must reproduce the engine's real evaluation. The tuner
   checks 20,000 positions and reports how many differ by more than 2 cp. Ours: 0. If this
   check fails, the trace has a bug, and the tuning optimises something else than the engine
   actually computes.
2. **Fit K:** the sigmoid scale is chosen first (ternary search) to fit the *current* weights
   best. Otherwise the tuner would "fix" a scale mismatch by inflating all weights.
3. **Optimise with Adam,** full batch (all positions per step), parallel over 16 threads, for
   a few thousand epochs. The gradient is analytic: the derivative of the sigmoid times the
   trace coefficients.

Our run: 3.9 million positions from self-play, 28.4 non-zero coefficients per position, 539
Scores (1,078 numbers), K = 1.075, loss 0.08947 → 0.08706.

## 6.6 Overfitting, and why regularisation mattered

The first tuning run had no constraints and reached a lower loss (0.08565). It looked
like a success, but the result contained this:

```
material = {S(114, 47), S(396, 262), S(436, 276), S(595, 437), S(1554, 515), S(0, 0)}
                                                                ^^^^^^^^^^^
```

A queen worth **15.5 pawns in the middlegame and 5.2 in the endgame**, barely more than a
rook (4.4). That's nonsense, and it shows what happens when the data doesn't pin a weight
down: endgames with queens are rare in the data, and other terms (mobility, threats, king
attacks) partly measure the same thing. The optimiser shifts value between correlated
weights in ways that fit the 3.9 million positions, but not chess.

The cure is **L2 regularisation**: a penalty for moving away from the starting values
(PeSTO), `reg · (w − w_start)²`. Weights only move as far as the data clearly supports.
Two strengths were tested with SPRT, against the untuned PeSTO-based eval:

| regularisation | Elo vs untuned |
|---|---|
| 1e-9 (weak) | +83 ± 33 |
| **1e-8** | **+104 ± 30** ← used |

The lower *loss* didn't mean a stronger engine. The general lesson: **a lower training loss
isn't the goal; the games are.** We met the same thing again with the NNUE king buckets
(chapter 7): the first king-bucket net had by far the lowest training loss and was clearly
weaker than the plain net.

## 6.7 Why NNUE won anyway

After tuning, the classical evaluation was decent: the engine already beat its predecessor
(the old 2100-Elo engine in this repository) by 82–1. And then the first, small network,
trained on just 26 million positions, beat it by **+217 Elo**.

The reason is structural. The classical eval is a **sum of independent terms**, each a human
idea. It can only see what someone thought of and wrote down, and it can't capture
*combinations* unless someone writes a term for each: "a knight on f5 is strong *if* the
opponent castled short *and* has no light-squared bishop *and* the g-pawn has moved."
Strong classical engines (Stockfish before 2020) had thousands of lines of such terms, and
years of work went into them.

The network gets only the raw position (which piece on which square) and learns its own
features from hundreds of millions of examples, including all the combinations nobody
would write down. The Texel method is the same idea in miniature: let the data decide. NNUE
just takes it from "the data decides the weights" to "the data decides the features too".

## 6.8 Pitfalls

1. **The trace doesn't match the eval.** Every term must be traced exactly the way it's
   computed, including the side and the count. The tuner's verification step catches it;
   without that check, such a bug can cost weeks.
2. **Training data from a different engine or style.** Positions from human games or a
   different engine have different typical errors. Self-play data from the engine itself
   (or a stronger one) works best.
3. **Positions that aren't quiet.** A position in the middle of a capture sequence has a
   static eval that says nothing about the result. Better tuners filter such positions, or use
   the position at the end of the quiescence search instead.
4. **No regularisation, or not testing the result.** See 6.6: the loss can improve while the
   engine gets weaker.
5. **Scale mismatch between eval and search.** Pruning margins (chapter 4) are in centipawns.
   If tuning changes the overall scale of the eval, all margins are suddenly off. Fitting K
   first prevents that.

## 6.9 Try it yourself

Compare the two evaluations of a position:

```
setoption name UseNNUE value false
position startpos moves e2e4 e7e5 g1f3 b8c6 f1b5 a7a6
eval
setoption name UseNNUE value true
eval
```

(Classical: −34, network: +13 from White's view. The two evaluations disagree on whether the
Ruy Lopez is good for White; the network's slight plus for White matches the usual assessment.)

Run the tuner yourself on the old self-play data:

```bash
make tuner
bin/tuner -e 1000 -reg 1e-8 data/selfplay_v1_*.txt > tuned.txt
```

Exercises, if you like:

* The Score packing uses `+ 0x8000` in `eg_value`. Construct a Score where the result would be
  wrong without it.
* Why is mobility counted only in the mobility area, and not over all attacked squares?
* The tuner fits `K` once at the start, before optimising. What would happen if `K` were
  optimised together with the weights?
* Which of the classical terms (6.3) would you expect the network to have learned on its own,
  and which might it struggle with? (Hint: think about what the network can see from
  "piece on square" alone. A safe check is about attacked squares, which the network can only
  infer indirectly.)

---

**Next:** Chapter 7 — NNUE: architecture, incremental updates, quantisation, training, king
buckets and the accumulator cache.
