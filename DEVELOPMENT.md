# Dark C. Helmet 2 — development guide

The new engine lives in `src/`. The old single-file engine (`engine_c.c`, tag `reference-0.2`)
is kept as a sparring partner; the untouched original is tag `baseline-0.1B`.

## Building

macOS / Linux:

```bash
make                # bin/darkhelmet
make reference      # bin/reference (old engine)
make tuner          # bin/tuner (Texel tuner, needs pthreads)
```

Windows (Developer PowerShell for VS 2022):

```powershell
cmake -S . -B build
cmake --build build --config Release --target darkhelmet
```

## Layout

| File | Contents |
|---|---|
| `src/types.h` | moves, pieces, squares, constants |
| `src/bitboard.*` | bitboard helpers, attack tables, magic bitboards (generated at start-up) |
| `src/position.*` | board state, FEN, make/unmake, legality, repetition, SEE |
| `src/movegen.*` | pseudo-legal move generation (noisy / quiet / all) |
| `src/eval.*` | tapered evaluation; all weights in the tunable struct `P` |
| `src/tt.*` | transposition table (5 entries per 64-byte bucket) |
| `src/search.*` | iterative deepening, aspiration windows, PVS, pruning, qsearch, time management |
| `src/uci.c` | UCI protocol, `bench`, `perft`, `genfens` |
| `src/datagen.*` | self-play data generation |
| `tools/` | testing and tuning scripts |

## Testing workflow

Every change that could affect playing strength is tested by playing games against the
previous version. Nothing is merged on intuition.

1. **Correctness** — after touching move generation or make/unmake:
   ```bash
   python3 tools/perft_suite.py bin/darkhelmet
   ```
   This checks node counts on six standard positions and verifies the incremental
   hash/evaluation state against a from-scratch recomputation.

2. **Bench** — `bin/darkhelmet bench` prints a node count over 18 fixed positions.
   A change that should not alter the search (refactoring, speed-ups) must keep this
   number identical. Put the bench number in the commit message.

3. **Strength (SPRT)** — keep the previous build (e.g. `cp bin/darkhelmet bin/base`), make
   the change, rebuild, then:
   ```bash
   SPRT=1 tools/match.sh bin/darkhelmet bin/base
   ```
   Defaults: 10+0.1 s, 8 games in parallel, openings from `tools/books/random8.epd`,
   SPRT bounds [0, 5] Elo. A result of `H1 accepted` means the change gains Elo. For pure
   simplifications use `ELO0=-5 ELO1=0` (accepted = not a loss). Games are saved in
   `tools/games/` (ignored by git). Needs fastchess, built next to this folder:
   `git clone https://github.com/Disservin/fastchess ../fastchess && make -C ../fastchess`.

## Evaluation tuning

1. Generate self-play data (one process per core, different seeds):
   ```bash
   bin/darkhelmet datagen <games> <nodes-per-move> <seed> data/selfplay_1.txt
   ```
   Each line is `fen | score | result` (score and result from White's view).
2. Tune: `bin/tuner -e 2000 data/selfplay_*.txt > tuned.txt`
   (checks that its linear model reproduces the engine's evaluation, fits the sigmoid
   scale K, then optimises all weights in `P` with Adam).
3. Apply: `python3 tools/tune/apply_params.py tuned.txt`, rebuild, SPRT against the
   previous build.

## UCI extensions

| Command | Purpose |
|---|---|
| `bench [depth]` | fixed-depth search over 18 positions; also `darkhelmet bench` from the shell |
| `perft <depth>` / `go perft <depth>` | move-generator node count with per-move breakdown |
| `d` | print the board, FEN and hash key |
| `eval` | static evaluation from the side to move's view |
| `genfens <n> [seed <s>] [plies <p>]` | random balanced openings (EPD) |
