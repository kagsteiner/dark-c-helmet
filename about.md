# Engine Overview (`engine_c.c`)

This engine is a single-file UCI chess engine written in C.

It uses a straightforward board representation, pseudo-legal move generation filtered for legality, an iterative deepening alpha-beta search with modern pruning/ordering heuristics, a handcrafted phase-aware evaluation, and a fixed-size transposition table indexed by Zobrist hash.

## Building

The project builds with CMake and MSVC. You must run build commands from **Developer PowerShell for VS 2022** (or *x64 Native Tools Command Prompt for VS 2022*). The developer shell initializes the environment so that `cmake` and `cl` (MSVC) are on PATH and the correct `INCLUDE`/`LIB` variables are set — a plain PowerShell or cmd will not have these.

**Prerequisites:** Visual Studio 2022 with *Desktop development with C++*, and CMake (via `winget install Kitware.CMake` or VS Installer).

**Build steps:**

1. Open *Developer PowerShell for VS 2022* (Windows key → type name → run).
2. `cd` to the project root.
3. Run:
   ```powershell
   cmake -S . -B build
   cmake --build build --config Release
   ```
   Or use `build_c.bat` from the project root.
4. Executable: `build\Release\vibechess_c.exe`

For a clean rebuild, delete the `build` folder and rerun the steps above. 

## Move Generator

### Board and move representation

- The board is represented as a 64-element array (`squares[64]`) with packed piece codes (`color << 3 | piece_type`).
- Game state includes side to move, castling rights, en passant square, halfmove clock, fullmove number, and tracked king squares.
- Moves store `from`, `to`, optional `promo` piece, flags (`castle`, `en passant`), and a search ordering score.
- Undo records are pushed for every make/unmake operation and include captured piece, previous irreversible state, moved piece, and king squares.

### Pseudo-legal generation

`gen_pseudo_moves()` creates pseudo-legal moves for the side to move:

- **Pawns**
  - Single and double pushes (double only from start rank and if intermediate square is empty).
  - Diagonal captures.
  - En passant captures when target equals current en passant square.
  - Full underpromotion set on promotion squares (Q/R/B/N).
- **Knights**
  - 8 leaper offsets with board bounds checks.
- **Bishops/Rooks/Queens**
  - Sliding ray generation until blocked.
  - Captures enemy piece and stops ray.
- **King**
  - One-square king moves.
  - Castling pseudo-moves only when:
    - king is not currently in check,
    - path squares are empty,
    - transit/destination squares are not attacked.

`captures_only` mode is supported to generate only tactical moves for quiescence.

### Legality filtering and make/unmake

- `generate_legal_moves()` calls pseudo generation, then validates each move by making it and rejecting moves that leave own king in check.
- `board_make_move()` updates:
  - board occupancy,
  - promotion replacement,
  - en passant capture removal,
  - castling rook movement,
  - castling-rights changes on king/rook move or rook capture,
  - halfmove clock, fullmove number, side to move, and en passant square.
- `board_unmake_move()` restores exact previous state from undo stack (including rook restoration in castling and EP captured pawn restoration).

This design is simple and reliable for search, with full reversibility and no incremental attack tables.

## Search Algorithm

### Core structure

- Search is **iterative deepening** from depth 1 up to requested depth/time.
- Node search uses **negamax** with **alpha-beta** bounds.
- Leaves use **quiescence search** over captures/promotions to reduce horizon effects.
- Root prints UCI `info` lines per completed depth with:
  - depth/seldepth,
  - nodes/time/nps,
  - score in centipawns,
  - hashfull estimate,
  - principal variation.

### Major pruning and reductions

- **Null-move pruning**
  - Enabled when not in check, depth >= 3, not near mate bounds, and with enough non-pawn material.
  - Uses dynamic reduction `R = 2 + depth/4`.
  - Performs a null-move verification search with a null window.
- **Principal Variation Search (PVS)**
  - First move searched full window.
  - Later moves searched with null window, then re-searched full window on fail-high-in-window.
- **Late Move Reductions (LMR)**
  - Applied to late quiet moves (non-capture, non-castle, non-promotion, non-check contexts) when depth and move index thresholds are met.
  - Reduced-depth null-window probe, with full re-search if result raises alpha.
- **Terminal handling**
  - No legal moves: checkmate returns `-MATE_SCORE + ply`, stalemate returns 0.
  - Fifty-move rule draw via `halfmove_clock >= 100`.

### Move ordering heuristics

Move ordering is critical and combines:

- TT best move first (very high priority),
- promotions,
- MVV-LVA-style capture scoring,
- killer moves per ply,
- history heuristic table indexed by side/from/to.

History values are decayed when they become too large.

### Time management

- Supports fixed `movetime`, `depth`, or clock-based allocation (`wtime/btime/winc/binc/movestogo`).
- Default allocation is roughly `our_time / movestogo + increment/2`, capped and safety-adjusted.
- Search checks stop condition periodically by node counter mask and wall clock.
- In non-fixed-depth timed mode, iteration may stop early after using about half of allocated time.

## Evaluation Function

### General design

Evaluation is handcrafted and phase-aware, returning score from side-to-move perspective:

- Base material values (`P=100, N=320, B=330, R=500, Q=900`).
- Piece-square tables (PSTs) for all pieces, with separate king PSTs for middlegame/endgame.
- Game phase classification is implemented in `get_game_phase()` and returns:
  - `0` = opening,
  - `1` = middlegame,
  - `2` = endgame.

### Exact game phase rules (implementation order)

The engine checks these in this exact order:

1. Compute piece counts and non-pawn material (`white_non_pawn`, `black_non_pawn`), where:
   - `non_pawn = total_non_king_material - pawn_count * 100`
2. Mark **endgame** if any of these is true:
   - both queens are gone (`white_queens == 0 && black_queens == 0`), or
   - both sides still have a queen, but neither side has rooks and both have at most one minor (`white_rooks == 0 && black_rooks == 0 && white_minors <= 1 && black_minors <= 1`), or
   - both sides have low non-pawn material (`white_non_pawn < 900 && black_non_pawn < 900`), or
   - combined non-pawn material is small (`white_non_pawn + black_non_pawn <= 1600`).
3. If any endgame condition is true, return `2` immediately.
4. Otherwise, if `fullmove_number <= 15`, compute `undeveloped` as the count of knights/bishops still on their start squares:
   - White: `b1`, `g1`, `c1`, `f1`
   - Black: `b8`, `g8`, `c8`, `f8`
5. Return **opening** (`0`) if either:
   - `fullmove_number <= 10`, or
   - `undeveloped >= 2`.
6. Otherwise return **middlegame** (`1`).

### Always-applied terms

- Material difference.
- PST contribution.
- Bishop pair bonus.
- Rook-structure helper:
  - rook on seventh rank,
  - open/semi-open files,
  - connected rooks (path-clear check).

### Pawn structure and passed pawns

`evaluate_pawn_structure_fast_c()` includes:

- doubled pawn penalties,
- isolated pawn penalties,
- backward pawn penalties (with adjacent-file and attack pattern checks),
- passed pawn bonuses by rank (when enabled in non-endgame call paths).

### Opening-specific terms

In opening phase, extra terms include:

- center and extended-center pawn occupancy bonuses,
- minor-piece development bonuses and undeveloped penalties,
- castled king bonus or castling-rights bonus,
- early queen development penalty if minors are underdeveloped,
- trapped/undeveloped bishop penalties (including rook trapped behind bishop motifs),
- knight quality (rim penalties and specific outpost bonuses).

### Middlegame-specific terms

- king pawn-shield safety pattern around castled-ish king zones,
- lightweight mobility/centrality bonus for knights/bishops,
- plus trapped-piece and knight-quality terms.

### Endgame-specific terms

Endgame swaps in specialized terms:

- advanced pawn bonuses,
- stronger passed-pawn bonuses,
- king-to-passed-pawn proximity race bonuses,
- rook behind passed pawn bonuses,
- king centralization bonus.

Overall, the evaluation is feature-rich for a compact engine and intentionally biased toward practical positional motifs rather than expensive deep static analysis.

## Transposition Table

### Hashing

- Uses Zobrist hashing over:
  - piece-square occupancy,
  - castling rights,
  - en passant file,
  - side to move.
- Random keys are generated once at startup via `splitmix64`.

### Table layout and replacement

- Single global TT array (`TTEntry*`) allocated by MB size option.
- Direct-mapped indexing via `key % size` (one entry per bucket, no chaining/clusters).
- Entry stores:
  - key,
  - depth,
  - score,
  - bound flag (`EXACT`, `LOWER`, `UPPER`),
  - best move,
  - age,
  - used marker.
- Replacement preference accepts overwrite when:
  - slot unused,
  - same key,
  - new depth >= old depth,
  - or entry is stale by age.

### Search integration

- Probe happens at each node before search expansion.
- If entry depth is sufficient:
  - exact returns immediately,
  - lower/upper tighten alpha/beta,
  - cutoff can occur from tightened window.
- Best move from TT is fed into move ordering.
- After node completion, result is stored with computed bound type.
- `hashfull` is estimated by sampling up to first 1000 entries and reported in UCI info.

## UCI Interface

The `main()` loop is a line-based UCI command parser with tokenization and command dispatch.

### Supported commands

- `uci`
  - outputs engine name/author,
  - declares `Hash` spin option (`default 64`, `min 1`, `max 1024`),
  - returns `uciok`.
- `isready` -> `readyok`.
- `ucinewgame`
  - resets board to start position,
  - clears transposition table.
- `setoption name Hash value <mb>`
  - reinitializes TT to requested MB size.
- `position`
  - supports `startpos`,
  - supports `fen ...`,
  - supports trailing `moves ...` list applied sequentially.
- `go`
  - parses `depth`, `movetime`, `wtime/btime`, `winc/binc`, `movestogo`,
  - computes time budget,
  - runs search,
  - prints `bestmove <uci>`.
- `stop`
  - currently parsed but effectively ignored (the engine does not set async stop from this command).
- `quit`
  - exits cleanly and frees TT memory.

### Practical notes

- Position move parsing uses UCI coordinate notation, including promotions.
- En passant and castling flags are inferred during move parse where appropriate.
- If no legal best move is found, engine outputs `bestmove 0000` fallback.

This is a functional baseline UCI implementation suitable for GUI integration and local engine testing.
