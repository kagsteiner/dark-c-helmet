# Backlog

Milestones in order. Each ends with something that runs in the browser and is tested there
(desktop and phone viewport, light and dark). Decisions are in `DESIGN.md`.

Status: `[ ]` open, `[~]` in progress, `[x]` done.

## M0 — Engine in the browser

- [x] WASM entry file (`webapp/engine/wasm_io.c`): command queue, UCI loop on a pthread,
      output lines to JavaScript; `#ifdef __EMSCRIPTEN__` input path in `uci.c`
- [x] WASM SIMD: not needed. Built with `-msimd128` (automatic vectorisation); a native build
      without any vectorisation is as fast as the normal one, so hand-written SIMD128 would
      not pay off
- [x] Build script (`webapp/engine/build.sh`): threaded and single-threaded variants
- [x] Net name in `src/nnue_net.c` (via `tools/nnue/embed.py`), reported as `info string net v11`
- [~] Measure nodes/s: native vs WASM on the Mac done (see DESIGN.md); iPhone still open
- [x] Rules module: `webapp/engine/rules_api.c` (FEN, legal moves, make/unmake, game state),
      36 KB WASM without search and net
- [x] Test page `engine-test.html`: `uci`, `go movetime`, `go infinite` + `stop`, `bench`
      (same node count as native), threads; rules perft matches on 21 positions (6 standard,
      15 Chess960) and game-state checks pass

## M1 — App skeleton and board

- [x] `webapp/` project: Vite, TypeScript, `npm run dev` with COOP/COEP headers
- [ ] `tokens.css` and base styles per the UI conventions; light/dark
- [ ] TypeScript wrapper for the rules module: game = start position + move list, replayed
      in the module
- [ ] SAN from the legal-move list (disambiguation, check/mate signs, Chess960 castling
      `O-O` / `O-O-O`); tests
- [ ] Board component: cburnett pieces, coordinates, flip, last move, selection, legal-move
      dots, arrows
- [ ] Move input: click-click, drag, target-only click, promotion picker, Chess960 castling
- [ ] Responsive layout shell: phone / tablet / laptop, navigation

## M2 — Playing a game

- [ ] Engine layer over `EngineTransport` (Web Worker); `info` parsing; download progress
- [ ] New-game sheet: variant, Chess960 start (random / number), colour, time control
- [ ] Clocks for all four time controls incl. FIDE classical; overrun shown in red
- [ ] Game flow: engine moves, game-end detection, engine resignation
- [ ] Premove
- [ ] Undo
- [ ] Evaluation and hint
- [ ] The star
- [ ] Current game survives a page reload (IndexedDB)

## M3 — Setup

- [ ] Position editor: empty / start / Chess960 start, place and remove pieces
- [ ] Side to move, castling rights (incl. Chess960 rook choice)
- [ ] Validation; "Play" and "Analyze" from the edited position
- [ ] FEN import/export
- [ ] e.p. square (prio 2)

## M4 — Analysis

- [ ] Endless analysis: depth, nodes, score, PV in SAN; start/stop
- [ ] Move through the game; try moves on the board without touching the game
- [ ] Opened from a game: clocks stop, star goes out, "Back to game"
- [ ] Full-game pass: time per move, eval graph, inaccuracy/mistake/blunder marks

## M5 — Opening book

- [ ] Position key (Shredder-FEN fields, e.p. only if capturable); IndexedDB store
- [ ] Node budget from time budget (measured nodes/s per device)
- [ ] Lookup with random choice within 10 cp; record and update after search
- [ ] Record from endless analysis
- [ ] Book screen: statistics, export to file, merge from file

## M6 — MVP polish and release

- [ ] Settings screen: threads, hash, target-only click, theme
- [ ] About: engine version, net, licences (cburnett attribution)
- [ ] Consistency pass over all screens
- [ ] nginx config with COOP/COEP on the VPS; deploy script; test on iPhone and Android

## After the MVP

- [ ] Seed book generator (native engine, tree expansion, standard and Chess960), resumable
- [ ] Rule for book entries from different nets
- [ ] PGN import (paste/file, choose game from multi-game file) and PGN export
- [ ] "My games" list
- [ ] Merge book from URL (static file on the VPS)
- [ ] MultiPV (engine change) and up to 3 analysis lines
- [ ] Strength levels
- [ ] Native engine on localhost (WebSocket bridge)
- [ ] Installable / offline (PWA)
- [ ] Variation tree and annotations in analysis
