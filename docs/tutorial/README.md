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
| 4 | Search, part 2: pruning, reductions and extensions (null move, LMR, singular extensions, …) | planned |
| 5 | Move ordering and history heuristics | planned |
| 6 | Classical evaluation and Texel tuning | planned |
| 7 | NNUE: architecture, incremental updates, quantisation, training | planned |
| 8 | Testing like engine developers do: perft, bench, SPRT; time management; Lazy SMP | planned |

A recurring theme: most of the strength of a modern engine does not come from one clever
idea, but from dozens of small, *measured* improvements. The history of this very repository
shows it — see [DEVELOPMENT.md](../../DEVELOPMENT.md) for the Elo each step was worth.
