# Dark C. Helmet 2

A UCI chess engine in C, with an NNUE evaluation trained from scratch on about a billion
positions of its own self-play games, plus a tutorial series that explains every part of it.

The engine was written with Claude (Anthropic) as a pair programmer, starting from an older
single-file engine of about 2100 Elo. Every change was measured with engine-vs-engine tests
(SPRT); [DEVELOPMENT.md](DEVELOPMENT.md) records what each step was worth.

## Why this project?

I wanted to try out whether Opus 5.5 can produce a state of the art chess engine from a
single, simple prompt. First I actually tried to refactor and improve an old chess engine
that a much older LLM (GPT 5?) had written which had about 2200 ELO. But as that proved
to be not the best idea we started from scratch. Afterwards I got a bit carried away, and
trained the NNUE network on about 1 billion positions, bringing the ELO rating from about
3200 ELO to about 3400 (?). Nearly all creativity and suggestions for how to continuously
improve the engine came from Claude; I just made a few decisions.

The embarrassing part: I have written a chess engine on my own some years ago which was
stuck at about 2000 ELO.

Claude has some more suggestions on how to further improve playing strength, but it seems
we're getting into the area where you need weeks of network training to make significant
progress, so I'll stop here.

BTW my name on some backgammon or chess servers is darkhelmet (after my favorite scifi
character :-) ), so this is the dark chess helmet, Dark C. Helmet.

## The big questions

As stockfish is open source, surely in Claude's training data, this could just be a slightly
eaker clone of stockfish. I haven't checked; from communication with Claude it seems that
it truly understands the concepts (see also the tutorial it has started) and is just able
to create such an engine.,. 

## Strength

Single thread each, 20 s + 0.2 s per game, 400 games against HIARCS 15.4 and 200 against
Shredder 14, on an Apple M5 Max:

| opponent | result | Elo difference |
|---|---|---|
| HIARCS 15.4 | +282 =83 −35 | **+250 ± 32** |
| Shredder 14 | +34 =83 −83 | **−87 ± 28** |

## Features

**Board and move generation:** bitboards with magic bitboards (generated at start-up),
16-bit moves, legality via pins and checkers, make/unmake with a state stack, Zobrist
hashing, static exchange evaluation. Verified with perft.

**Search:** principal variation search with iterative deepening and aspiration windows;
transposition table (5 entries per 64-byte bucket); quiescence search with SEE and delta
pruning; null move pruning, reverse futility pruning, razoring, late move reductions, late
move pruning, futility and SEE pruning; check and singular extensions (with multi-cut and
negative extensions); internal iterative reduction; mate distance pruning.

**Move ordering:** staged move picker (hash move, good captures, killers, countermove, quiet
moves by history, bad captures); butterfly, continuation (1 and 2 ply) and capture history;
correction history for the static evaluation.

**Evaluation:** NNUE with (768 × 7 king buckets → 512) × 2 perspectives → SCReLU → 8 output
buckets by piece count; mirrored king buckets, factorized training, incremental accumulator
updates with an accumulator cache ("Finny table"); int16 quantisation. A tuned hand-crafted
evaluation is still available (`UseNNUE false`).

**Search parameters** tuned with SPSA; **time management** by best-move stability, effort
share and score trend; **Lazy SMP** for up to 64 threads.

## Building

macOS / Linux (clang or gcc):

```bash
make                 # -> bin/darkhelmet, optimised for this machine (-march=native)
./bin/darkhelmet bench
```

Windows (Developer PowerShell for VS 2022):

```powershell
cmake -S . -B build
cmake --build build --config Release --target darkhelmet
```

The network is embedded in the binary (`src/nnue_net.c`, generated from `nets/net_v10.nnue`);
no extra files are needed at run time.

## Usage

Any UCI chess GUI works (Arena, Cute Chess, Banksia, HIARCS Chess Explorer, …). Options:

| option | default | meaning |
|---|---|---|
| `Hash` | 64 | transposition table size in MB |
| `Threads` | 1 | search threads (1–64) |
| `Move Overhead` | 20 | milliseconds reserved per move for GUI / network delays |
| `Clear Hash` | | empties the transposition table |
| `UseNNUE` | true | false = hand-crafted evaluation |
| `EvalFile` | `<embedded>` | load another network file from `nets/` |

Extra commands on the console: `bench [depth]`, `perft <depth>`, `d` (show the board),
`eval`.

## Tutorial

[docs/tutorial](docs/tutorial/README.md) explains the engine topic by topic, for programmers
who know how to code but haven't seen the inside of a modern chess engine, with the real code
and measurements from this engine:

1. [Bitboards](docs/tutorial/01-bitboards.md)
2. [Move generation, legality, make/unmake, hashing, perft](docs/tutorial/02-move-generation.md)
3. [Search basics: alpha-beta, PVS, iterative deepening, transposition table, quiescence](docs/tutorial/03-search-basics.md)
4. [Pruning, reductions and extensions](docs/tutorial/04-pruning-reductions-extensions.md)
5. [Move ordering and history heuristics](docs/tutorial/05-move-ordering.md)
6. [Classical evaluation and Texel tuning](docs/tutorial/06-classical-eval-texel.md)
7. [NNUE: architecture, incremental updates, quantisation, training](docs/tutorial/07-nnue.md)
8. [Testing, SPRT and SPSA; time management; Lazy SMP](docs/tutorial/08-testing-time-smp.md)
9. [From 2100 to 3400: a retrospective](docs/tutorial/09-retrospective.md)
10. [What's still missing](docs/tutorial/10-whats-missing.md)

## Repository layout

| path | contents |
|---|---|
| `src/` | the engine |
| `nets/` | all trained networks, v2 to v10 (v10 is embedded) |
| `tools/nnue/` | self-play data pipeline and the NNUE trainer (plain C, CPU) |
| `tools/spsa/` | SPSA tuner for search parameters |
| `tools/tune/` | Texel tuner for the hand-crafted evaluation |
| `tools/match.sh` | engine-vs-engine matches and SPRT with [fastchess](https://github.com/Disservin/fastchess) |
| `tools/books/random8.epd` | 4,000 balanced openings for testing |
| `docs/tutorial/` | the tutorial |
| [DEVELOPMENT.md](DEVELOPMENT.md) | how to build, test, tune and train, and the measured history of every change |

The training data itself (about 1 billion positions, ~100 GB) is not part of the repository;
`tools/nnue/pipeline.sh` generates new data of the same kind with the engine.

## Credits

* Starting values of the hand-crafted piece-square tables: PeSTO by Ronald Friederich.
* Testing: [fastchess](https://github.com/Disservin/fastchess).
* Countless ideas documented by the computer chess community, above all on the
  [Chess Programming Wiki](https://www.chessprogramming.org).

## License

[MIT](LICENSE)
