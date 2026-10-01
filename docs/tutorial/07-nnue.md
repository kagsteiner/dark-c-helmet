# Chapter 7 — NNUE: architecture, incremental updates, quantisation and training

> **Files:** [`src/nnue.c`](../../src/nnue.c), [`src/position.h`](../../src/position.h)
> (accumulators), [`src/datagen.c`](../../src/datagen.c), [`tools/nnue/trainer.c`](../../tools/nnue/trainer.c),
> [`tools/nnue/train_round.sh`](../../tools/nnue/train_round.sh)

NNUE ("efficiently updatable neural network", the acronym reversed, often stylised ƎUИИ) was
invented by Yu Nasu in 2018 for computer shogi. In 2020 it came to Stockfish and added
roughly 80–100 Elo overnight to what was already the strongest engine in the world. Within
two years, practically every serious engine had one.

In this engine, NNUE was the biggest single step: the first small network beat the tuned
classical evaluation of chapter 6 by **+217 Elo**, and eight more training rounds added
about 400 more (measured in self-play). This chapter explains how it works, from the architecture down to the
integer arithmetic, and how the networks were trained.

## 7.1 The architecture

```
  position, seen from White          position, seen from Black (board flipped)
  ───────────────────────            ──────────────────────────────────────────
  768 inputs × 7 king buckets        768 inputs × 7 king buckets
  (piece type × colour × square)     (same weights, other perspective)
            │                                     │
            ▼                                     ▼
   accumulator: 512 numbers             accumulator: 512 numbers
            │                                     │
            └────────── side to move first ───────┘
                              │
                     1024 numbers, SCReLU
                              │
                 output layer (one of 8, chosen by piece count)
                              │
                       evaluation in centipawns
```

**Inputs.** For each perspective, 768 binary inputs: "is there a (own/enemy) (pawn …
king) on (a1 … h8)?". 2 × 6 × 64 = 768. In any position, only the occupied squares
are 1: at most 32 of 768. With king buckets (7.7), there are 7 such blocks of 768,
and only the block for the current king position is active.

**Two perspectives.** The network evaluates the position twice, once from White's view and
once from Black's (with the board flipped vertically). "Own" and "enemy" pieces are relative
to the perspective. Both use the **same weights**. That halves what the network has to learn:
"a knight on f3 next to my castled king" is the same knowledge for both sides.

**First layer: the accumulator.** 768 × 512 weights (per king bucket). Its output is simply
the sum of the weight columns of all active inputs, plus a bias:

```
accumulator[h] = bias[h] + Σ (over all pieces on the board) weight[feature(piece, square)][h]
```

**Activation: SCReLU.** "Squared clipped ReLU": `clamp(x, 0, 1)²`. Cheap, and the squaring
gives the network some ability to model interactions between features.

**Output layer.** The two accumulators are concatenated, **side to move first**, so the network
knows who's to move, and multiplied with 1,024 output weights. There are 8 output layers, and
the number of pieces on the board selects one: an endgame with 6 pieces is evaluated by
different weights than a middlegame with 28.

That's the whole network: **one hidden layer**. The 7 × 768 × 512 ≈ 2.75 million input
weights contain almost all the knowledge; the output layer has just 8 × 1,025. Stockfish's
network has more layers after the accumulator, but the principle, a huge sparse first layer
followed by something small, is the same.

## 7.2 Why it's fast: the accumulator is updated, not recomputed

A naive evaluation would sum 30 weight columns of 512 numbers for every position:
15,000 additions. The trick that gives NNUE its name: **a move changes only 2–4 inputs.**

* A quiet move: one piece leaves a square (subtract its column), appears on another (add).
* A capture: additionally, the captured piece disappears (subtract).
* Castling: king and rook move (two subtractions, two additions).
* Promotion: the pawn disappears, the new piece appears.

So the accumulator of the child position is the parent's accumulator plus or minus 2–4
columns: about 1,500 additions instead of 15,000, and they vectorise perfectly (16 or 32
int16 additions per CPU instruction).

### How the engine organises this

Make-move (chapter 2) records which pieces changed in the new state, the **dirty pieces**
([`src/position.c:83`](../../src/position.c#L83)): up to three entries "piece P went from
square A to square B", where A or B can be "nowhere". It doesn't touch the accumulator.

There's one accumulator per ply on a stack, next to the state stack, each with a
`computed` flag per perspective. Only when `evaluate()` is actually called does
`make_current()` ([`src/nnue.c:306`](../../src/nnue.c#L306)) bring it up to date:

```c
// walk back to the nearest ancestor whose accumulator is computed
while (!pos->acc[k].computed[p]) {
    if (k == 0 || king_view_changed(&pos->states[k], p)) { refresh_cached(...); return; }
    k--;
}
// replay the dirty-piece updates from there
for (int m = k + 1; m <= idx; ++m) update(&pos->acc[m], &pos->acc[m - 1], &pos->states[m].dirty, p, kv);
```

This **lazy** scheme matters because many positions are never evaluated: nodes that are cut
off by the transposition table, or pruned before the static eval. Their accumulators are never
computed, and the next evaluation simply replays several moves at once.

`update()` ([`src/nnue.c:247`](../../src/nnue.c#L247)) has specialised loops for the common
cases (1 add + 1 subtract, 1 + 2, 2 + 2), each a single pass over the 512 values. The compiler
turns them into NEON (Apple) or AVX2 (Intel) vector code.

## 7.3 Quantisation: integer arithmetic

The network is trained with floating-point numbers, but the engine computes with **16-bit
integers**: faster, twice as many values per vector instruction, and bit-exact results
on every platform, which matters for reproducible tests (the bench node count is identical
on every machine).

[`src/nnue.c:37`](../../src/nnue.c#L37):

```c
#define QA 255     // scale of the first layer: weights and accumulator × 255
#define QB 64      // scale of the output layer: weights × 64
#define SCALE 150  // centipawns per unit of network output
```

* First-layer weights and the accumulator are stored × 255 as int16. The activation's clamp
  `[0, 1]` becomes `[0, 255]`.
* Output weights are stored × 64.

The output computation ([`src/nnue.c:322`](../../src/nnue.c#L322)) contains a nice trick:

```c
int16_t c = clamp(v[h], 0, QA);          // clipped activation, 0..255
int16_t cw = (int16_t)(c * w[h]);        // c · w fits in int16: |w| ≤ 127
sum += (int32_t)cw * c;                  // c² · w, the squared activation times the weight
```

`SCReLU(x) · w` would be `c² · w`, and `c²` doesn't fit into 16 bits (255² = 65,025).
Computing `(c · w) · c` instead keeps the first product in 16 bits, which is the trick
vectorised implementations rely on. It only works if `|w · 255| < 32,768`, so the trainer
**clips the output weights** to ±1.98 (× 64 ≈ 127). The engine and trainer must agree on
every such detail; the trainer has a `check` mode that computes evaluations with exactly the
engine's integer arithmetic for comparison.

The final scaling: the sum is at scale QA² · QB. Divide by QA, add the bias (stored at QA ·
QB), and convert to centipawns with `· SCALE / (QA · QB)`.

**About SCALE:** the network learns to predict a *win probability* via a sigmoid (7.6).
`SCALE` = 150 says how many centipawns correspond to one unit in front of that sigmoid. It must
match the scale the search's margins (chapter 4) were designed for. The very first network
in this project was trained with 400, so it produced evaluations 2.7 times larger than the
classical eval. All pruning margins suddenly meant something else, and the stronger network
**lost 123 Elo** until the scale was fixed. One constant.

## 7.4 Output buckets

`nnue_evaluate` picks one of 8 output layers by the number of pieces
([`src/nnue.c:346`](../../src/nnue.c#L346)):

```c
bucket = (popcount(pos->occupied) - 2) / 4;      // 2–5 pieces → 0, …, 30–32 → 7
```

Each bucket has its own 1,024 output weights and bias. The accumulator (the expensive part)
is shared; only the cheap last step specialises by game phase. It's the NNUE version of the
tapered evaluation from chapter 6.

We also tried splitting by "queens on / off" (4 piece-count ranges × queens). With a
plain network it looked slightly better (+14.6 vs +9.7 Elo against the previous net), but on
top of king buckets it lost 7.5 Elo against the pure piece-count split. Sometimes a good idea
in isolation doesn't add anything once other features cover the same information.

## 7.5 King buckets, mirroring, factorizer, accumulator cache

This was the subject of a whole training round. In brief (DEVELOPMENT.md has all numbers):

**King buckets.** The first layer is a sum, so the weight of "enemy knight on f3" can't
depend on where my king is. King safety, the most important positional factor, is exactly
such an interaction. King buckets give each **region of the own king** its own set of input
weights. Our layout (`KING_BUCKET_LAYOUT_7`, [`src/nnue.c:65`](../../src/nnue.c#L65)), from
the perspective's view:

```
ranks 3-8   6 6 6 6     king far forward: one bucket (mostly endgames)
rank 2      4 4 5 5
rank 1      0 1 2 3     back rank: a bucket per square
            a b c d     (files e-h are mirrored onto d-a)
```

**Mirroring.** If the king is on files e–h, the whole board is flipped left-right for that
perspective (`flip ^= 7` in `king_view`, [`src/nnue.c:160`](../../src/nnue.c#L160)). The
network only learns "king on the a–d side", and a king on g1 uses the b1 weights. Half the
weights, twice the data per weight.

**Feature index** ([`src/nnue.c:180`](../../src/nnue.c#L180)) puts it all together:

```c
return kv.offset            // king bucket × 768
     + (color == perspective ? 0 : 384)   // own or enemy piece
     + type * 64                          // pawn … king
     + (sq ^ kv.flip);                    // square: ^56 = flipped for Black, ^7 = mirrored
```

**Factorizer (training only).** Each bucket learns only from positions with the king in its
region, and rare regions overfit. The trainer therefore splits each weight into a shared part
(learned from all positions) and a per-bucket correction. When the net is saved, the two are
added, so the engine sees an ordinary king-bucket net.

**Accumulator cache ("Finny table").** When the king changes bucket, all input weights
change, and the accumulator must be rebuilt from scratch. `refresh_cached()`
([`src/nnue.c:207`](../../src/nnue.c#L207)) keeps, for each bucket and mirror side, the last
accumulator plus the piece bitboards it was computed for, and only applies the difference.
Because int16 addition wraps around, the order of additions doesn't matter, and the result is
bit-identical to a full rebuild.

The results: the factorized 7-bucket net on 998 million positions: **+33.7 Elo**; the
accumulator cache on top: **+39.1 Elo** (22 % more nodes per second). The first, unfactorized
attempt with 273 million positions had lost against the plain network: the same idea, with too
little data and no factorizer.

## 7.6 Training data

The network learns from **self-play**: the engine plays against itself, and every position
gets two labels ([`src/datagen.c`](../../src/datagen.c)):

* the **search score** of the position (from a short search, 5,000 nodes),
* the **game result** (1 / ½ / 0).

Details that matter:

* **Openings:** 8 or 9 random moves from the starting position, then a search. If the score
  is beyond ±300, the opening is discarded as too unbalanced. That gives millions of
  different games without an opening book.
* **5,000 nodes per move:** very fast games (about 20 ms per game in total with 17 processes).
  The search is shallow, but the *quantity* matters more than the quality of each game.
* **Only quiet positions are recorded:** not in check, and the best move isn't a capture or
  promotion. In the middle of an exchange, the static position says little about the result,
  and the network would learn noise. (It's the same idea as qsearch: evaluate only quiet
  positions.)
* **Adjudication:** a game is scored as won once the score stays above ±2000 for 4 plies, and
  as drawn after move 40 once it stays within ±10 for 12 plies. That saves time without
  distorting results.

Each data block went into the next training round, and the next network played the next
games: a **self-improvement loop**. Better net → better games → better data → better net.
About 9.7 million games and 998 million positions went into net v10.

## 7.7 The training target and the trainer

The trainer ([`tools/nnue/trainer.c`](../../tools/nnue/trainer.c)) is a plain C program: no
PyTorch, no GPU, about 600 lines.

**Target** ([`tools/nnue/trainer.c:299`](../../tools/nnue/trainer.c#L299)):

```c
target = lambda * sigmoid(score / SCALE) + (1 - lambda) * wdl;      // lambda = 0.75
loss   = (sigmoid(network_output) - target)²;
```

The network predicts a win probability. The target blends the two labels:

* the **search score** (converted into a probability by the same sigmoid): precise,
  but only as good as a 5,000-node search;
* the **game result**: the truth about the game, but noisy, because one bad move later in
  the game decides it, not the position itself.

75 % score and 25 % result is a common compromise. The score gives the network a dense,
smooth signal; the result corrects systematic errors of the search, for example an engine
that is always too optimistic about a certain pawn structure.

**Optimisation:**

* **AdamW**, batch size 16,384, weight decay 0.01;
* **cosine learning-rate schedule:** from 0.001 down to 1 % of that over the whole run;
* **12 epochs** (each position is seen 12 times);
* **validation** on the last 200,000 positions, never trained on;
* **all 16 threads:** each computes the gradient of part of the batch; the Adam step is also
  parallel.
* After every step, the weights are **clipped** to the range the int16 quantisation can hold
  (7.3).

Training net v10 took about 4 hours per candidate on the Mac's CPU (998M positions × 12 epochs).
A GPU would be much faster. For our network size, the CPU was enough.

## 7.8 The history of our networks

| net | positions | change | Elo vs previous |
|---|---|---|---|
| v2 | 26 M | first net (from classical-eval self-play) | +217 vs classical |
| v3 | 75 M | + data from NNUE self-play | +152 |
| v4 | 150 M | more data; 512 instead of 256 hidden neurons | +100 |
| v5 | 273 M | more data | +58 |
| v6 | 344 M | more data | +10.7 |
| v7 | 483 M | more data (better engine) | +23.3 |
| v8 | 663 M | more data (SPSA-tuned engine) | +10.6 |
| v9 | 834 M | more data | +9.7 |
| **v10** | **998 M** | **7 factorized king buckets** | **+33.7** |

Two lessons are visible:

1. **More data has diminishing returns** for a fixed architecture: from +152 to about +10 per
   round.
2. **When the returns flatten, a bigger architecture helps,** but only if there's enough data
   to fill it. 512 hidden neurons were worse than 256 at 75M positions (−15 Elo) and only
   break-even at 150M; king buckets lost at 273M and won clearly at 1 billion.

## 7.9 Pitfalls

1. **Scale mismatch** between the net's output and the search's margins (7.3: −123 Elo).
2. **Integer overflow** in the quantised arithmetic. Accumulators are int16: the sum of 32
   weight columns must not exceed ±32,767, hence the weight clipping in the trainer.
3. **Missed special cases in incremental updates:** castling (two pieces move), en passant
   (the captured pawn isn't on the target square), promotion (the pawn disappears, another
   piece appears). Errors there don't crash anything; the evaluation is just slightly wrong
   in some positions. The `NNUE_VERIFY` build recomputes every accumulator from scratch and
   compares; run it after every change to the update code.
4. **Trainer and engine disagree** on feature indices, bucket layouts or the activation. The
   trainer's `check` mode computes evaluations with the engine's exact integer arithmetic.
   They must match the engine's `eval` command exactly, for every position.
5. **Overfitting** when the network has more weights than the data can support (the first
   king-bucket net, 7.5). Watch the gap between training and validation loss.
6. **Judging a net by its validation loss.** As in chapter 6, only games decide. Different
   nets can have nearly the same loss and differ by 10 Elo.

## 7.10 Try it yourself

```
position startpos
eval
```

Then compare networks (`EvalFile`) in the same position:

```
setoption name EvalFile value nets/net_v4.nnue
eval
setoption name EvalFile value nets/net_v10.nnue
eval
```

And verify the incremental updates yourself:

```bash
cc -O3 -march=native -std=c11 -DNNUE_VERIFY -o bin/dh-verify src/*.c -lm -lpthread
```

Run a search with it: after every million evaluations, it reports the number of mismatches,
which must be 0.

Exercises, if you like:

* Why does the network see the side to move only through the *order* of the two
  accumulators, and is that enough?
* With mirroring, a king on e1 uses the same weights as a king on d1. In which positions could
  that be a problem? (Hint: castling rights.)
* Training uses `lambda` = 0.75. What would you expect with `lambda` = 1 (score only) or 0
  (result only)?
* The accumulator cache stores bitboards per bucket. Why not simply the last position's
  accumulator per bucket, recomputed when needed?

---

**Next:** Chapter 8 — Testing like engine developers do: perft, bench, SPRT and SPSA; time
management; Lazy SMP.
