# How Dark C. Helmet 2 works — a chess programming tutorial

This series explains the engine in `src/` topic by topic. It is written for readers who
program well but have not seen the inside of a modern chess engine — or who wrote one years
ago, got it to around 2100 Elo, and want to know what separates that from 3000+.

Each chapter explains the idea, shows the actual code (with file and line references), and
points out the pitfalls that cost real engines real Elo.

| # | Chapter | Status |
|---|---|---|
| 1 | [Bitboards: representing the board](01-bitboards.md) | ✅ |
| 2 | [Move generation, legality, make/unmake, Zobrist hashing, perft](02-move-generation.md) | ✅ |
| 3 | [Search basics: alpha-beta, PVS, iterative deepening, transposition table, quiescence](03-search-basics.md) | ✅ |
| 4 | [Pruning, reductions and extensions (null move, LMR, futility, singular extensions, …)](04-pruning-reductions-extensions.md) | ✅ |
| 5 | [Move ordering and history heuristics; correction history](05-move-ordering.md) | ✅ |
| 6 | [Classical evaluation and Texel tuning](06-classical-eval-texel.md) | ✅ |
| 7 | [NNUE: architecture, incremental updates, quantisation, training, king buckets](07-nnue.md) | ✅ |
| 8 | [Testing like engine developers do: perft, bench, SPRT, SPSA; time management; Lazy SMP](08-testing-time-smp.md) | ✅ |
| 9 | [From 2100 to 3400: a retrospective](09-retrospective.md) | ✅ |
| 10 | [What's still missing: tablebases, pondering, bigger networks, …](10-whats-missing.md) | ✅ |

A recurring theme: most of the strength of a modern engine does not come from one clever
idea, but from dozens of small, *measured* improvements. The history of this very repository
shows it — see [DEVELOPMENT.md](../../DEVELOPMENT.md) for the Elo each step was worth.
