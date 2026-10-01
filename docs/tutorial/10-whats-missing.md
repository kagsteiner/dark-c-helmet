# Chapter 10 — What's still missing

Dark C. Helmet 2 plays strong chess, but it isn't complete. Compared with top engines, a
number of features and techniques are missing. Some of them would make it stronger; others
are about usability; a few would only pay off with far more compute than one laptop.

This chapter goes through them: what each one is, how it works, and roughly what it would
bring here. The Elo estimates are educated guesses based on what other engine authors report,
not measurements in this engine.

## 10.1 Overview

| feature | kind | expected gain here | effort |
|---|---|---|---|
| simplification tests (razoring, IIR) | cleanup | 0 to +5 | hours |
| second SPSA run, more parameters | tuning | +5 to +15 | a night |
| finer LMR and pruning rules | search | +10 to +30 in total, over many small steps | days, many SPRTs |
| endgame tablebases (Syzygy) | knowledge | +5 to +20 (more at longer time controls) | a day + disk space |
| better training data | evaluation | +10 to +40 | weeks of compute |
| bigger network | evaluation | uncertain; needs more data first | days + compute |
| pondering | usability / strength in real games | 0 in testing; real gain in games against people and GUIs | a day |
| MultiPV, `searchmoves`, Chess960 | usability (analysis) | 0 | hours to a day |
| NUMA, large pages | speed on big machines | 0 to +5 on a laptop | a day |

## 10.2 Cleanup and tuning (cheap)

**Simplification tests.** The ablation in chapter 4 found no measurable value for razoring
and internal iterative reduction (+8 and +9 ± 15 Elo *without* them). A simplification
SPRT (bounds [−5, 0], chapter 8.3) would show whether they can be removed. Less code with
the same strength is a gain: every rule in the search interacts with every other, and fewer
rules make the next change easier to evaluate.

**A second SPSA run.** The constants were tuned for net v7 at build 58. Since then, the
evaluation (king buckets) and the speed (accumulator cache) have changed, and the best
margins shift with them. Adding more parameters would help even more: the time management
factors, the correction-history weights and limits, and the individual LMR adjustments that
are currently fixed at one ply each.

## 10.3 Finer search rules (many small steps)

Top engines have far more conditions in LMR and pruning than this one. A few well-known ones:

* **Fractional reductions.** LMR computed in 1/1024 ply instead of whole plies, so that small
  adjustments add up instead of being rounded away.
* **TT-PV flag.** Remember in the TT whether a position was ever on a principal variation, and
  reduce such positions less, even when they're later searched with a null window.
* **Cut-node reductions.** Nodes expected to fail high (cut nodes, chapter 3.1) can be reduced
  more.
* **LMR for captures.** Losing captures (negative SEE) reduced as well.
* **History-based pruning.** Skip quiet moves with very bad history at low depth.
* **ProbCut.** If a shallow search with a raised window (beta + margin) already fails high,
  the full-depth search very probably would too; return early. (Originally from Othello, by
  Michael Buro.)
* **Double and triple extensions.** If a singular move is *very* singular (the alternatives
  fail far below), extend it by two plies instead of one, with limits per line.

Each typically brings 2–10 Elo, each needs its own SPRT, and the gains are not independent.
This is the patient part of engine development: dozens of small, measured steps.

## 10.4 Endgame tablebases (Syzygy)

**What they are:** precomputed databases with the exact result of *every* position with up to
N pieces (including kings). The standard today is the **Syzygy** format by Ronald de Man:

| pieces | size | contents |
|---|---|---|
| up to 5 | about 1 GB | all 3-, 4- and 5-piece endgames |
| up to 6 | about 150 GB | |
| up to 7 | about 17 TB | |

There are two kinds of tables: **WDL** (win/draw/loss, compact, probed during the search) and
**DTZ** (distance to the next zeroing move, i.e. a capture or pawn move; used at the root, to
make progress in won endgames without violating the 50-move rule).

**How an engine uses them:**

* **In the search:** when a position with ≤ N pieces is reached (typically after a capture),
  probe WDL. The result is exact, so the node can return immediately with a win, draw or loss
  score. That turns hard endgames (KRB vs KR, KQ vs KR) into simple lookups.
* **At the root:** if the root position itself is in the tables, use DTZ to choose moves that
  keep the win and make progress.

**What it brings:** the engine already plays most endgames well; tablebases help mostly in the
few positions where it doesn't (fortresses, very long wins, tricky draws), and those are rare in
fast games. Typical reports are +5 to +20 Elo, more at longer time controls.

**Implementation:** almost every engine uses the **Fathom** library (a standalone C port of the
probing code) instead of writing its own. It needs a `SyzygyPath` UCI option, the probe in
`search()` after the TT probe, and root filtering. The 5-piece tables (1 GB) are a good start.

## 10.5 Better training data

The network's quality is limited by its data. Ideas that strong engines use:

* **More nodes per move.** Our games used 5,000 nodes per move. With 10,000–20,000, the scores
  would be more accurate, but every position would cost proportionally more compute. A trade-off
  between quantity and quality that can only be decided by testing.
* **Filtering.** Remove positions that don't teach anything: positions where the side to move
  is in check (already done), positions whose score is far from the game result, positions
  very early in the game (all similar to each other).
* **Diverse openings.** Our games start with 8 random moves. More variety, for example random
  positions from Chess960 starting arrays, gives the network more different structures to
  learn from.
* **Rescoring.** Re-evaluate old positions with the current, stronger engine instead of keeping
  the scores from the weaker engine that generated them.

## 10.6 A bigger network

The current network is 7 × 768 → 512 → 8 outputs. Top engines use considerably bigger ones:

* **More hidden neurons** in the first layer (1024 to 3072).
* **More layers** after the accumulator. Stockfish, for example, has a few small dense layers
  between the accumulator and the output. They cost little time, because they're tiny compared
  to the first layer, but give the network more capacity to combine features.
* **More king buckets** (up to one per king square) and other input features.

The catch, as chapter 7.8 showed twice: a bigger network needs **more data** before it pays off,
and it's **slower**, which costs search depth. With one laptop, the realistic next step would
be 768 or 1024 hidden neurons on 2–3 billion positions, with an honest chance that the slower
evaluation eats the gain.

**GPU training** would change the economics. Training on the CPU took about 4 hours per network
here. A GPU trainer (several open-source trainers exist, such as Stockfish's `nnue-pytorch` or
the Rust-based `bullet`) is typically 10–50× faster, which makes it practical to try many more
architectures. But the data still has to be generated by playing games, and that stays on the
CPU.

## 10.7 Pondering

**What it is:** thinking during the opponent's time. The engine guesses the opponent's most likely
reply (the second move of its PV, sent as `bestmove e2e4 ponder e7e5`), and the GUI lets it search
the position after that reply while the opponent thinks (`go ponder`). If the opponent plays the
expected move (`ponderhit`), the engine already has a head start, often of several seconds. If
not (`stop`, then a new `go`), the effort is lost, but the TT still contains useful entries.

**What it brings:** in testing, nothing: test matches are usually played without pondering, and
both engines would gain equally. In real games against people or engines that don't ponder,
it's effectively more thinking time: typically the expected move is played in 50–70 % of cases,
which means a substantial gain.

**Implementation:** the `ponder` and `ponderhit` handling in the UCI loop, plus time management
that knows the clock only starts at `ponderhit`.

## 10.8 Analysis features

These bring no Elo, but make the engine more useful in a GUI for analysis:

* **MultiPV:** report the best N moves with their scores instead of only the best. Implemented by
  searching the root N times, each time excluding the moves already found (the same
  exclusion mechanism as singular extensions, chapter 4.9).
* **`searchmoves`:** restrict the search to given root moves.
* **Chess960 (Fischer Random):** castling rules for arbitrary starting positions. Mostly a
  move-generation and FEN/UCI notation issue (king captures own rook to castle). Also useful
  for training data (10.5).
* **WDL output:** `info ... wdl 450 400 150`, the expected win/draw/loss probabilities,
  derived from the score with a fitted model.

## 10.9 Speed on large machines

On many-core servers, **NUMA** awareness (keeping each thread's memory local to its CPU) and
**large pages** for the transposition table (fewer TLB misses) bring measurable speed. On a
laptop with one memory controller, the effect is small.

## 10.10 Where I'd go next

If this engine were to continue, my order would be:

1. **Simplification tests** (razoring, IIR): cheap, and they make the code base cleaner for
   everything after.
2. **A second, extended SPSA run:** one night, probably +5 to +15.
3. **Syzygy tablebases (5 pieces) via Fathom:** a well-understood day of work.
4. **Finer search rules,** one SPRT at a time, over weeks.
5. **More and better data** for the king-bucket network, 2–3 billion positions, and then a test
   of a bigger network.
6. **Pondering and MultiPV,** for use in a GUI.

Each of these is a self-contained project, and the chapters of this tutorial contain everything
needed to understand, implement and measure them.

---

This is the end of the tutorial. The [README](README.md) lists all chapters.
