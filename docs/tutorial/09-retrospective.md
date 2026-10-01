# Chapter 9 — From 2100 to 3400: a retrospective

> **Sources:** the Git history of this repository, [DEVELOPMENT.md](../../DEVELOPMENT.md),
> and the match logs. All Elo figures are measured; the ones from self-play are against the
> engine's own previous version (chapter 8).

Chapters 1–8 explain how the engine works. This chapter looks back at how it got there:
which steps brought how much, what didn't work, and in which order you'd do it again. If you
have an engine of your own at around 2100 Elo, this is the chapter meant for you.

## 9.1 The timeline

Most of the work happened in nine days, from 23 September to 1 October 2026, with the Mac
running tests and data generation day and night.

| stage | what happened | measured |
|---|---|---|
| **0. Starting point** | a single-file engine of about 2100 Elo, written earlier with an older AI model | — |
| **1. Bug fixes** | repetition detection, mate scores in the TT, qsearch in check, UCI stop handling, an evaluation that depended on the move number | not measured separately |
| **2. Rewrite** | bitboards, magic move generation, a modern search with TT buckets, PVS, null move, LMR, pruning; a tapered evaluation with PeSTO tables | new engine vs. fixed old one: **82–1** |
| **3. Texel tuning** | 539 evaluation weights fitted to 3.9M positions, with regularisation | **+104** |
| **4. Search** | continuation history | +25 to +37 |
| | singular extensions | +26 |
| **5. NNUE** | first network, 26M positions from self-play with the classical eval | **+217** |
| | net v3 (75M), output buckets | +152 |
| | net v4 (150M), 512 hidden neurons | +100 |
| | Lazy SMP (4 threads vs. 1, same time) | +176 |
| **6. Refinements** | net v5 (273M) | +58 |
| | capture history, time management, correction history | +3.5, +3.1, +10.5 |
| | net v6 (344M) | +10.7 |
| | staged move picker | +45 |
| | net v7 (483M) | +23 |
| **7. Tuning and data** | SPSA on 21 search constants | +20.5 |
| | nets v8 (663M), v9 (834M) | +10.6, +9.7 |
| **8. King buckets** | net v10: 7 factorized king buckets, 998M positions | +33.7 |
| | accumulator cache (Finny table) | +39.1 |

Against outside engines (single thread each, 20 s + 0.2 s):

| build | HIARCS 15.4 | Shredder 14 |
|---|---|---|
| 39 (net v4) | +116 ± 26 | |
| 57 (net v7) | +220 ± 29 | |
| 62 (SPSA, net v8) | +192 ± 29 | −141 ± 30 |
| **69 (net v10, cache)** | **+250 ± 32** | **−87 ± 28** |

## 9.2 Where the Elo came from

Grouping the self-play gains (they don't add up exactly, and self-play exaggerates
somewhat, but the proportions are telling):

| source | approx. Elo (self-play) | share of the effort |
|---|---|---|
| **evaluation: NNUE** (nets v2–v10) | **≈ +600** | most of the compute: data generation and training |
| evaluation: Texel tuning | +104 | one afternoon |
| search: new features and refinements | ≈ +190 | most of the programming |
| tuning: SPSA | +20 | one night of compute |
| speed: staged picker, accumulator cache | ≈ +85 | two days of programming |
| parallelism: Lazy SMP | +176 (at 4 threads) | half a day |

And in absolute terms: from about 2100 to a level where the engine beats HIARCS 15.4 by 250
Elo. If HIARCS is around 3300 on your scale, that puts the engine near 3500 at these fast time
controls (less at longer ones, chapter 8.2).

The big picture:

1. **The rewrite was the precondition, not the gain itself.** 82–1 against the bug-fixed old
   engine is huge, but almost nothing in it was new: a correct, modern standard search.
   Everything else built on it.
2. **The evaluation brought the most.** First Texel tuning, then NNUE. The very first, small
   network was worth more than all search improvements together.
3. **Speed counts as much as cleverness.** Two optimisations that didn't change a single
   decision of the engine (identical bench node count) were worth +85 Elo combined.
4. **The returns shrink**, as everywhere. The first network gave +217, the ninth +10. The
   first SPSA run +20, a second one would bring less.

## 9.3 What didn't work

Failures teach as much as successes. Every one of these was caught by measurement, not by
thinking:

| idea | what happened | lesson |
|---|---|---|
| first NNUE with output scale 400 | **−123 Elo**, although the network itself was good | one mismatched constant between training and search (chapter 7.3) |
| Texel tuning without regularisation | lower loss, but a queen worth 5 pawns in the endgame | a better fit isn't a stronger engine (chapter 6.6) |
| 512 hidden neurons at 75M positions | −15 Elo vs. 256 | a bigger network needs more data first |
| 8 king buckets at 273M positions | weaker than the plain net (overfitting) | same idea, 4× the data and a factorizer: +34 |
| hand-written NEON code for NNUE | slower than what the compiler produced (3.30M vs. 3.42M nodes/s) | measure before assuming you can beat the compiler |
| queen-based output buckets | +14.6 with a plain net, −7.5 on top of king buckets | features overlap; re-measure in each new context |
| killers and countermoves | 8 % fewer nodes without them | node counts aren't Elo: the games say keep them (chapter 5.5) |
| razoring and IIR | no measurable value in this engine (+8, +9 ± 15 when removed) | standard techniques aren't automatically useful in every engine |

There were operational lessons too: training data doesn't belong in a cloud-synced folder (it
was moved out of OneDrive); a data run stopped early because a per-process game limit was hit
before the time limit; a rented server would have delivered only a fraction of a modern
laptop's compute; an older Windows laptop overheated at a tenth of the Mac's throughput.

## 9.4 What it cost

| resource | amount |
|---|---|
| test games (SPRT, matches, ablations) | about 82,000 recorded games + 32,000 SPSA games |
| self-play games for training data | about 9.7 million (998 million positions, ~100 GB) |
| data generation | roughly 60 hours on 17 cores |
| network training | roughly 30–40 hours (CPU, 16 threads) |
| hardware | one laptop (Apple M5 Max, 18 cores, 48 GB) |

No GPU, no server, no cluster. For an engine at this level, a single modern machine is enough,
provided it can run day and night.

## 9.5 If you have a 2100 engine: the order I'd recommend

From this project's experience, roughly ordered by Elo per effort:

**1. Correctness first.** Check for exactly the bugs the old engine had (stage 1): repetition
detection, mate scores in the TT adjusted for ply (chapter 3.6), qsearch that handles check
(3.7), a search that discards interrupted iterations (3.9), and an evaluation that doesn't
depend on anything but the position. Run perft on the standard positions. Every one of these
bugs costs Elo silently.

**2. Testing infrastructure, before any improvement.** fastchess, an opening book, a `bench`
command, SPRT (chapter 8). Without it, you're tuning by feel, and half of what you add will make
the engine weaker without your noticing.

**3. The big search techniques,** in the order of the ablation table (chapter 4.1): LMR
(with a history adjustment), reverse futility pruning, late move pruning, null move pruning.
Each of them is worth 40–120 Elo. Plus PVS, aspiration windows, a transposition table with
proper bounds.

**4. Move ordering:** hash move first, MVV-LVA, history with gravity and malus, continuation
history (chapter 5). This makes the techniques of step 3 work much better.

**5. Evaluation tuning:** if you have a hand-crafted eval, Texel-tune it with regularisation
(chapter 6). One afternoon, typically +50 to +100.

**6. NNUE.** The biggest single step. Start small: 768 → 256 → 1, no buckets, trained on a few
tens of millions of positions from your own engine's self-play. Then iterate: new data from the
stronger engine, a new network, repeat. Add output buckets, more neurons and king buckets only
when the data is there.

**7. Then the long tail:** SPSA for all constants, singular extensions, correction history,
speed work (staged move picker, accumulator cache), Lazy SMP.

As a rough estimate, steps 1–4 take a 2100 engine to somewhere around 2700–2900; step 6 is what
makes 3000+ possible on a single machine.

## 9.6 The most important lessons

If I had to condense this project into five sentences:

1. **Measure everything.** Intuition about what helps is unreliable, even for experts; the
   SPRT isn't.
2. **The evaluation is the biggest lever,** and today that means a neural network trained on
   your own games.
3. **Data before architecture.** A bigger network only pays off once there's enough data to
   fill it.
4. **Speed is strength.** An optimisation that changes nothing but the nodes per second is worth
   real Elo.
5. **Small gains add up.** Most single improvements were worth 3–30 Elo. A few dozen of them
   turned 2100 into 3400+.

---

**Next:** Chapter 10 — What's still missing: tablebases, pondering, MultiPV, bigger networks,
GPU training and other directions this engine could take.
