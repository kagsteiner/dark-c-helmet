# Dark C. Helmet web app — design

The requirements are in `../webapp.md`. This file records the decisions taken on top of them.
The work plan is in `BACKLOG.md`.

## Architecture

- **Client-only.** The engine runs in the browser as WebAssembly. There is no backend in the MVP;
  games, settings and the opening book live on the device (IndexedDB).
- **Hosting.** `npm run build` produces static files (`webapp/dist/`). They are served by nginx on
  the VPS (HTTPS already set up). Two headers are required, otherwise the engine runs with one
  thread only:

  ```nginx
  add_header Cross-Origin-Opener-Policy same-origin;
  add_header Cross-Origin-Embedder-Policy require-corp;
  ```

  Threads need a secure context: `localhost` or HTTPS. A second, single-threaded engine build
  is shipped as well; the loader picks it when threads are unavailable (e.g. `http://<LAN-IP>`
  from the phone during development).
- **Stack.** TypeScript, Vite (dev server and build tool, development only), Emscripten for the
  engine. No UI framework: plain DOM code organised in small modules. No runtime dependencies
  unless a backlog item says otherwise.
- **Chess rules from the engine.** The UI uses the engine's own move generator, compiled as a
  second, small WASM module (`bitboard.c`, `position.c`, `movegen.c`; no search, no net,
  ~100–200 KB). It runs on the page itself, so calls are synchronous and independent of the
  searching engine in the worker. One source of truth: the generator is perft-tested,
  including Chess960 castling. A new file `webapp/engine/rules_api.c` exports what the UI
  needs, without changes to `src/`:

  | Function | Uses |
  |---|---|
  | set FEN / get FEN (incl. Shredder-FEN) | `pos_set_fen`, `pos_to_fen` |
  | legal moves (from, to, promotion, castling flag) | `generate_legal` |
  | make / unmake move, UCI move parsing | `pos_make_move`, `pos_unmake_move`, `pos_parse_move` |
  | in check, piece on square | `in_check`, `piece_on` |
  | game state: mate, stalemate, threefold, 50 moves, insufficient material | `generate_legal`, `pos_is_draw(pos, 0)` |

  The game is replayed in this module from its start position, so threefold repetition sees
  the whole history. Insufficient material as the engine defines it: no pawns, rooks or queens
  and at most one minor piece in total.

  TypeScript adds only thin layers on top of the legal-move list: SAN (with disambiguation),
  setup-board validation messages and, after the MVP, PGN. Chess libraries are not used
  (chess.js has no Chess960; chessops is GPL-3.0 and the repository is MIT).
- **Later: native engine on localhost.** All engine traffic goes through one interface that
  speaks UCI lines:

  ```ts
  interface EngineTransport {
    send(line: string): void;
    onLine(handler: (line: string) => void): void;
    close(): void;
  }
  ```

  MVP implementation: a Web Worker running the WASM engine. Later: a WebSocket to a small
  local bridge that runs `bin/darkhelmet`. Everything above the transport (search requests,
  `info` parsing, time handling, the book) is shared.

## Engine as WebAssembly

- Two modules from the same sources: the **rules module** (see above) and the **search
  engine** described here.
- The search engine is built with `emcc` from the unchanged `src/` files, `-pthread`, `-msimd128`, the net embedded
  (as today). Expected download ~6–7 MB, shown as "Downloading engine…" on first start, then
  cached by the browser.
- **Input.** The native engine reads stdin with `fgets`, and polls stdin during search to see
  `stop`. In the browser a blocking read is not possible. The WASM build gets a small entry
  file (`webapp/engine/wasm_main.c`) that exports `uci_command(const char*)`: commands are
  queued from JavaScript and the search runs on a pthread, so `stop` arrives while it thinks.
  Only `uci.c` input handling is touched, behind `#ifdef __EMSCRIPTEN__`; search and evaluation
  stay identical, checked with `bench` (same node count as native).
- **SIMD.** Built with `-msimd128`; clang vectorises the plain NNUE loops itself. No
  hand-written SIMD128: a native build without any vectorisation is as fast as the normal
  one, so the accumulator code is not the bottleneck.
- **Measured (M5 Max, Chrome engine of the desktop app).** `bench`, one thread: native
  3.95M nodes/s, WASM 3.04M (77%) once the browser has optimised the code; the very first
  search after loading runs at about a quarter of that speed. The app should run a short
  warm-up search after loading. 8 threads: about 20M nodes/s. Node counts are identical to
  native.
- **Memory.** Static data is 119 MB (16 search threads at most in the WASM build, the net,
  the boards), plus the hash table. To be checked on the iPhone; if it is too much, the
  thread data can be allocated on demand.
- **Resources.** Threads: cores − 1 on desktop, 2 on phones (setting). Hash: 256 MB desktop,
  64 MB phones (setting). Memory growth disabled above that to stay within iOS limits.
- **Net version.** `tools/nnue/embed.py` also writes the net's name (`v11`) into
  `src/nnue_net.c`; the engine reports it as `info string net v11` after `uci`. Book entries
  store it.

## Screens

| Screen | Purpose |
|---|---|
| Play | the game in progress; new-game sheet (variant, start position, colour, time control) |
| Setup | position editor, then "Play" or "Analyze" |
| Analysis | endless analysis of the current position; full-game pass with eval graph |
| Book | statistics, export, merge from file |
| Settings | threads, hash, move input, theme |

Navigation: one top-level menu (phone: bottom bar; tablet/desktop: left rail or top bar).

### Play

- **Variants.** Standard and Chess960. Chess960 start: random, by number (0–959), or from Setup.
- **Colour.** White, black, random.
- **Time controls.**
  - seconds per move (engine only; the human has no clock)
  - minutes per game
  - minutes per game + increment
  - FIDE classical: 90 min for 40 moves, then 30 min for the rest, 30 s increment from move 1
- **Move input.**
  - click source then target; drag and drop
  - click target only: if exactly one own piece can move there, it moves (setting, on by
    default)
  - promotion: piece picker
  - Chess960 castling: king onto its own rook, or king two squares towards it when that is
    unambiguous
  - one premove while the engine thinks; any other click cancels it
- **Game end.** Mate, stalemate, threefold repetition, 50-move rule and insufficient material
  end the game automatically. The engine resigns at −10 pawns or worse held for 4 of its moves.
- **Time forfeit.** The game continues; the human's clock shows the overrun in red.
- **Hints.** "Evaluation" (score and depth) and "Hint" (best move shown as an arrow) at any time.

### The star

Lit at the start of a game. It goes out (outline only) after any of: undo, evaluation, hint,
opening Analysis, time forfeit. It has no other effect. Clicking it shows one line:

- lit: "Clean game so far: no undo, no hints."
- out: "Star lost: you used an undo." (or hint / analysis / time)

### Analysis

- Endless analysis of the current position: depth, nodes, score, PV (in SAN). One line in
  the MVP; MultiPV comes later (needs an engine change).
- Full-game pass: a fixed time per move; result is an eval graph and marks for inaccuracy /
  mistake / blunder.
- Opened during a game: both clocks stop, the star goes out, moves tried in analysis do not
  touch the game, "Back to game" resumes exactly where it was.
- Import PGN (post-MVP), FEN import/export (MVP).

### Setup

Empty board, start position, Chess960 start position. Tap a piece to remove it; pieces of both
colours are listed next to (desktop) or below (phone) the board: pick one, then tap squares.
Side to move, castling rights (for Chess960: which rook), e.p. square (only offered when a
double step could just have happened; prio 2). Validation before "Play" / "Analyze".

## Opening book

### Entry

| Field | Meaning |
|---|---|
| `key` | position: piece placement, side to move, castling rights (Shredder-FEN, so Chess960 works), e.p. square only if an e.p. capture is legal |
| `move` | UCI move (Chess960 castling as king-takes-rook) |
| `nodes` | nodes searched |
| `depth` | completed depth |
| `score` | centipawns from the side to move |
| `net` | net version, e.g. `v11` |
| `build` | engine build string |
| `source` | `game`, `analysis` or `seed` |
| `date` | when the entry was written |

Several moves per position are allowed. Only positions up to move 20 are stored, and only from
games that began at a standard or Chess960 start position.

### Use during a game

1. The engine's time manager decides the time for this move. With the device's measured
   nodes per second this becomes a node budget.
2. Candidates: entries for the position with `nodes` ≥ budget. If there are any, pick at random
   among those whose score is within 10 cp of the best candidate, and play it at once.
3. Otherwise search. Then: if this move already has an entry with fewer nodes, replace it;
   otherwise add a new entry.

Endless analysis that reaches a deeper search than the stored one also writes an entry.

**Open:** entries from different nets (100k nodes with v12 vs 200k nodes with v11). For now
all nets are treated alike; the rule is decided when v12 exists.

### Sharing

- MVP: export to a file; merge from a file. On merge, for the same position and move the
  entry with more nodes wins.
- Post-MVP: a seed book built on the Mac with the native engine (single thread, so node
  counts mean the same as in the browser), by tree expansion: the best move is searched deeply,
  plausible alternatives are branched into so that human deviations are covered. Output is the
  same file format.
- Later: "merge from URL", fetching a static file from the VPS (read-only; you upload by
  `scp`).

## UI conventions

The rules every screen follows. Exact values live as CSS variables in one file
(`src/styles/tokens.css`); no screen defines its own colours, sizes or button styles.

- **Boxes only for key elements:** the board, dialogs/sheets and the analysis output.
  Everything else is separated by whitespace and, where needed, a single hairline.
- **One typeface:** the system UI font stack. Monospaced digits (`tabular-nums`) for clocks,
  scores and node counts.
- **Four text sizes:** small (13 px: labels, secondary info), body (15 px), title (20 px),
  clock (28 px on phone, 32 px from tablet up). Two weights: regular and semibold.
- **Spacing:** multiples of 4 px; the usual steps are 8, 16, 24.
- **Buttons, three kinds:**
  - primary — filled accent colour, one per view at most ("Start game")
  - secondary — text in accent colour, no frame
  - icon — 44 × 44 px touch target, icon only, with a tooltip/label
- **Colours:** background, text, muted text, hairline, accent, danger (red clock), and the
  board set (light square, dark square, last move, selection, legal-move dot, premove, arrow).
  Light and dark theme follow the system.
- **Pieces:** cburnett SVG set (CC BY-SA 3.0; attribution in the About text).
- **Motion:** pieces slide 150 ms; nothing else animates.
- **English only. No sounds.**

## Layout

- **Phone (portrait).** Board full width. Above it the engine's name and clock, below it
  yours. Below that the move list (one line, scrolls sideways) and the action bar: undo,
  hint, star, menu.
- **Tablet / laptop.** Board on the left, as large as the height allows. Panel on the right:
  engine clock on top, move list, your clock at the bottom, actions below it.
