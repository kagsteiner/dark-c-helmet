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

- [x] Position key (FEN fields 1-4; the engine writes e.p. only if capturable); IndexedDB
      store with an index on the key; castling stored as king takes rook in both variants
- [x] Node budget from time budget: the engine's own time formula × measured nodes/s of
      this device (moving average, remembered)
- [x] Lookup: entries from 85% of the budget on, random choice within 10 cp; record and
      update (deeper search wins) after every engine search, hint and evaluation
- [x] Record from endless analysis and the game review
- [x] Book screen: statistics, export to file, merge from file (one transaction), clear
      with confirmation

## M6 — MVP polish and release

- [x] Settings screen: threads, hash, target-only click, theme (system / light / dark)
- [x] About: engine build, net, threads, measured speed, licences (cburnett attribution)
- [x] Consistency pass over all screens (headings, spelling, phone and desktop, light and
      dark)
- [x] Deploy script (`deploy/deploy.sh`) and nginx configuration (`deploy/nginx.conf`)
- [x] Deployed: https://srv706843.hstgr.cloud/chess/ (static files in `~/nodejs/chess`, one
      `location /chess/` block in the nginx site; threads work)
- [ ] Test on iPhone and Android (speed, memory, touch input)

## After the MVP

- [x] Seed book generator (`tools/seed-book.ts`: native engine, tree expansion, standard and
      Chess960, resumable); the engine now prints the totals of each search before `bestmove`
- [ ] Rule for book entries from different nets
- [ ] PGN import (paste/file, choose game from multi-game file) and PGN export
- [ ] "My games" list
- [x] Master book on the VPS (`tools/publish-book.ts`; startup check, ask or merge
      automatically; Book screen section)
- [x] Book contributions, server (DESIGN.md, Opening book → Contributions): endpoint
      `/chess/api/` and `book-admin` on the VPS (register, approve with `--user`, revoke,
      status, submit)
- [x] Book contributions, app: device key and Settings section, outbox, sending in the
      background
- [x] Publishing on the VPS (`book-admin publish`) with counts per user
- [ ] Later, near a million book moves: delta files; merge and statistics without loading the
      whole book
- [ ] MultiPV (engine change) and up to 3 analysis lines
- [ ] Strength levels
- [ ] Native engine on localhost (WebSocket bridge)
- [ ] Installable / offline (PWA)
- [ ] Variation tree and annotations in analysis
