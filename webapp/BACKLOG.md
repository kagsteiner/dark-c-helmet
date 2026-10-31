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
- [x] `tokens.css` and base styles per the UI conventions; light/dark
- [x] TypeScript wrapper for the rules module (`chess/game.ts`): game = start position + move
      list, replayed in the module when another game used it
- [x] SAN from the legal-move list (disambiguation, check/mate signs, Chess960 castling
      `O-O` / `O-O-O`); `npm test`
- [x] Chess960 start positions by number (`chess/chess960.ts`), all 960 checked against
      `tools/books/frc960.epd`
- [x] Board component: cburnett pieces, coordinates, flip, last move, selection, legal-move
      dots, check, sliding pieces; arrows implemented (first used by the hint in M2)
- [x] Move input: click-click, drag, target-only click, promotion picker, Chess960 castling
      (king onto rook, or onto its target square when that is not an ordinary king move)
- [x] Responsive layout shell: top bar with links (wide) or menu (phone); Play screen in
      phone, tablet and landscape layouts. For now both sides are moved by hand;
      `#/play?fen=…&chess960=1` starts from a position

## M2 — Playing a game

- [x] Engine layer over `EngineTransport` (`engine/engine.ts`): one search at a time, `info`
      parsing, stop (single-threaded build: restart); download progress; 1.5 s warm-up
- [x] New-game sheet: variant, Chess960 start (random / number), colour, time control;
      last choices remembered
- [x] Clocks for all four time controls incl. FIDE classical (`play/clocks.ts`, tests);
      overstepping shown in red, the game goes on
- [x] Game flow (`play/controller.ts`): engine moves, game-end detection, engine resigns at
      -10 or worse on 4 moves in a row
- [x] Premove (one; any click cancels it; promotes to a queen)
- [x] Undo: back to the player's turn, at least one of their moves taken back
- [x] Evaluation and hint (2 s search; hint as an arrow)
- [x] The star
- [x] Current game survives a page reload (IndexedDB); clocks do not run while the app is
      closed or another screen is shown

## M3 — Setup

- [x] Position editor: start / Chess960 / empty / current game; palette to place pieces,
      tap to remove, drag to move
- [x] Side to move, castling rights (outermost rook on each side of the king, so Chess960
      positions work; written as Shredder-FEN when not standard)
- [x] Validation (kings, pawns on the edge ranks, piece counts, side not to move in check);
      "Play" (new-game sheet without the variant choice) and "Analyze" (opens Analysis,
      which comes in M4)
- [x] FEN import/export (editable FEN field)
- [x] e.p. square: offered only when a double step could just have happened

## M4 — Analysis

- [x] Endless analysis: score, depth, nodes, speed, PV in SAN, best move as an arrow;
      start/stop
- [x] Move through the line (buttons, arrow keys, clicking moves); try moves on the board,
      which replace the rest of the line without touching the game
- [x] Opened from a game: clocks stop, star goes out, "Back to game"; from Setup with a
      position
- [x] Full-game review: time per position (0.5–10 s), evaluation graph (hover, click to
      jump), marks ?! ? ?? by the drop in winning chances (lichess thresholds), summary
      per side

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
