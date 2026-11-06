# Dark C. Helmet web app — design

The requirements are in `../webapp.md`. This file records the decisions taken on top of them.
The work plan is in `BACKLOG.md`.

## Architecture

- **Client-only.** The engine runs in the browser as WebAssembly. There is no backend in the MVP;
  games, settings and the opening book live on the device (IndexedDB). After the MVP, one
  small endpoint takes opening book contributions (see Opening book → Contributions).
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

Navigation: a top bar. From 768 px wide it shows the screens as links; on phones a menu
button opens them as a list. The bottom of the phone screen belongs to the action bar.

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
- **Chess960 first move.** With a clock, the player gets extra seconds for their first move
  (default 30, "Extra seconds for your first move"), whichever colour they play: time to look
  at the starting position. The extra time runs before the clock and is not added to it;
  unused seconds are dropped.
- **Hints.** "Evaluation" (score and depth) and "Hint" (best move shown as an arrow) at any time.

### The star

Lit at the start of a game. It goes out (outline only) after any of: undo, evaluation, hint,
opening Analysis, time forfeit. It has no other effect. Clicking it shows one line:

- lit: "Clean game so far: no undo, no hints."
- out: "Star lost: you used an undo." (or hint / analysis / time)

### Analysis

- Endless analysis of the current position: depth, nodes, score, PV (in SAN). One line in
  the MVP; MultiPV comes later (needs an engine change).
- Full-game pass: a fixed time per position; result is an eval graph and marks for
  inaccuracy / mistake / blunder. A move is judged by how much it lowers the mover's winning
  chances (from the centipawn score, as on lichess): 5 / 10 / 15 percentage points.
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
2. Candidates: entries for the position with `nodes` ≥ 85% of the budget (a search of the
   same time does not reach exactly the same node count). If there are any, the engine
   plays one at once: chosen at random among the moves within 0.3 pawns of the best up to
   move 5 (varied openings), within 0.1 pawns later. The new-game sheet's "Engine's
   openings: Strongest" (standard chess only) makes it always play the best-scored move.
3. Otherwise search. Then: if this move already has an entry with fewer nodes, replace it;
   otherwise add a new entry.

Endless analysis that reaches a deeper search than the stored one also writes an entry.

**Open:** entries from different nets (100k nodes with v12 vs 200k nodes with v11). For now
all nets are treated alike; the rule is decided when v12 exists.

### Sharing

- MVP: export to a file; merge from a file. On merge, for the same position and move the
  entry with more nodes wins.
- Seed book (`tools/seed-book.ts`): built on the Mac with the native engine, one
  single-threaded engine per core with a fixed node count per move. The opening tree is
  expanded level by level: each position gets a deep search (its best move is the entry);
  where the tree branches (`--widths`, e.g. 3 moves per ply for the first plies), every
  legal move gets a short probe search and the best alternatives within `--margin` are
  explored too, so that human deviations are covered. Transpositions are expanded once. The
  output is a normal book file; a state file next to it makes runs resumable.
- Node counts are the engine's totals of the whole search (its final `info nodes … time …`
  line), in the app and in the generator alike; the last `info depth` line only counts
  completed iterations.
- Master book: the seed book, published as static files next to the app (`book/manifest.json`
  and `book/master-<version>.json.gz`, built and uploaded by `tools/publish-book.ts`). The
  file is compact (moves grouped by position; no ids, build strings or dates) and gzip
  compressed, about 15 bytes per move. At startup the app fetches the manifest; for a newer
  version it asks "Merge / Later" (Later: not asked again for that version), or merges it
  by itself when the Book screen's setting says so. The Book screen shows the merged version
  and offers newer ones. Only you publish, on the VPS (see Contributions). Book files from
  others are not merged into it: a merge keeps the higher node count, so a bad file could push
  wrong moves to everyone. Entries from browsers you approved are the exception.

### Contributions

Search results from browsers you approved go into the master book by themselves. Only
approved devices can send, and nothing they send is searched again.

**Devices and users**

- Settings → Opening book contributions → "Take part" creates a key pair in this browser
  (WebCrypto, ECDSA P-256) and keeps it in IndexedDB. The private key is not extractable: the app can
  sign with it, but nobody can read it out, so it cannot be forwarded. The setting says what
  is sent: the positions and moves this browser's engine searched, under the user's name.
- The app registers the public key with the server as *pending*, with an optional name
  ("Fred's iPhone"), and shows a short device code: the first 8 characters of the public
  key's SHA-256 in base32, e.g. `K7QF-2M9X`.
- The friend sends you the code. On the VPS: `~/nodejs/chess-api/book-admin approve K7QF-2M9X
  --user fred` (`book-admin pending` lists the waiting ones).
  Further devices of the same person get the same `--user`. Each browser is a device of its
  own (Safari and Chrome on one Mac are two codes); clearing the site's data loses the key,
  and the browser has to be approved again.
- Settings shows the state: pending, "Contributing as fred" with how many moves fred has sent
  and how many are in the master book, or revoked.
- Pending registrations expire after 7 days, and at most 50 are kept, so strangers cannot
  fill the list.
- `book-admin revoke <code>` or `book-admin revoke --user fred` stops a device or a person.
  Their entries leave the master book with the next publish, which rebuilds it from all
  inputs.

**What is sent**

- Every entry this browser's engine writes to the local book (game move, hint, evaluation,
  endless analysis, game review) with at least **50 million nodes**: 3.3 s at 15 M nodes/s
  (a Mac), 11 s at 4.7 M nodes/s (an iPhone).
- Recording already keeps only searches deeper than what the local book has for this
  position and move, and the local book contains the merged master book. So only new or
  deeper results are sent. Entries merged from files or from the master book are never sent.
- Standard chess and Chess960 alike (the key is Shredder-FEN), so a 960 book can grow over
  time.

**Sending in the background**

- Entries go into an outbox in IndexedDB, keyed like book entries (position + move). A
  deeper result for the same move replaces the waiting one: endless analysis that improves
  an entry ten times sends it once.
- An entry is sent once it has not changed for 2 minutes: a timer fires 2 minutes after the
  last change. Besides, the app sends at startup, when the page is hidden (`fetch` with
  `keepalive`, one batch of 200), when the device is back online, and every 10 minutes. Up to 500 entries per request; after a
  failure the app waits 1 minute, doubling up to 1 hour. (The Background Sync API exists only
  in Chromium browsers, so it is not used.)
- The server answers with the ids it took, including ones it already had; only those leave
  the outbox. Sending twice does no harm.
- Entries recorded while the device is pending wait in the outbox and go out after approval.
  The outbox holds at most 20 000 entries (the oldest go first). When the device is revoked,
  the outbox is emptied and sending stops.

**Server**

- A small Node process (`server/`, pm2 name `chess-api`, 127.0.0.1:3060) behind one nginx
  location, `/chess/api/` (`deploy/nginx.conf`). The VPS has Node 20, which cannot run
  TypeScript, so `npm run server:build` bundles it; `server/deploy.sh` copies it to
  `~/nodejs/chess-api` and restarts it. `npm run server` runs it locally, and the dev server
  forwards `/api/` to it. Its data lives outside the web
  folder, in `~/chess-data/` on the VPS: users, devices, pending registrations, and one raw
  log per device (JSON lines, append only).
- Endpoints: `register` (public key, name), `status`, `submit`. Every request except
  `register` is signed; the server checks the signature with the stored public key.
- Checks on `submit`, all cheap: device approved, format, the move is legal in the position
  (the app's rules module, run in Node), at least 50 million nodes, at most 5 000 entries per
  user and day (against a bug that sends in a loop). No search: nothing is calculated again.
- The endpoint stores no IP addresses (nginx's own logs aside).

**Publishing**

- On the VPS, by hand: `~/nodejs/chess-api/book-admin publish`. It rebuilds the master book from all inputs:
  the seed books (uploaded from the Mac into `~/chess-data/seed/`) and the logs of all
  approved devices. For the same position and move the deeper search wins, with equal nodes
  the earlier one; all contributors count the same. It writes `master-<version>.json.gz` and
  `manifest.json` into `~/nodejs/chess/book/`, which a deploy never touches.
- This replaces publishing from the Mac (`tools/publish-book.ts --upload`, still there for
  tests); both write versions with `server/master-write.ts`. Seed books from the Mac go to the
  VPS with `rsync <file> vps:chess-data/seed/`.

**Counting**

- An entry counts for its user when a publish puts it into the master book: new there, or
  deeper than the master's entry for that move. The count only grows: if someone later
  replaces the entry with a deeper one, the earlier contributor keeps the credit. Resent
  entries and ones the book already had deeper do not count; seed books count for no one.
- `book-admin users` lists the counts. Later the manifest can carry them, so the Book screen
  can show who contributed how much without another endpoint. The names are then visible to
  everyone, so use names your friends agree to.

**Size**

The JSON file is only the transport. In the app the book lives in IndexedDB with an index on
the position, so lookups do not slow down as it grows. Master book version 4: 10 371 moves,
742 KB as JSON, 106 KB compressed (about 10 bytes per move). 100 000 moves (about 1 MB to
download) work as things are. Around a million moves (about 10 MB) two things change:

- delta files ("changes since version N") instead of the whole book for every new version;
- merging and the Book screen's statistics stop loading the whole local book into memory
  (merge: look up only the incoming entries; statistics: count with a cursor).

### Exploring

The Explore page (`#/explore`, linked from Settings) searches new positions in the background,
in a Chrome tab of its own, on a computer that is on anyway. Standard chess or Chess960 (by
default 70%, because Chess960 comes first for this app).

- **Where it searches:** a walk starts from a random start position and plays moves up to the
  first position without an entry of at least 50 million nodes. Each move comes from a short
  probe of all legal moves (200 000 nodes each, kept per position for the session): within 60 cp
  of the best, at most 4, each half as likely as the one before. So poor moves are not explored,
  and common positions get filled first. Existing entries are not deepened.
- **What it stores:** the position's best move, and the move that led there with the negated
  score, as the seed book does. Both as source `analysis`, so they reach the master book through
  the outbox like any other deep search (Contributions).
- **Fixed nodes:** the time per position is turned into nodes once, with a 3 s measurement at
  Start. Chrome may slow a hidden tab; a search then takes longer but stays as deep. The engine's
  `go nodes` counts the main thread's nodes, so the limit is divided by the threads.
- **In the background:** each search starts when the last one ends, driven by the engine's
  messages, so Chrome's timer throttling of hidden tabs (once a minute) does not matter. Whether
  exploring is on is remembered: an open Explore page carries on after a reload. Leaving the page
  pauses it. The speed shown for a visible and a hidden tab tells whether Chrome slows it.
- **Several tabs:** a Web Lock allows one explorer per browser; a second Explore page waits and
  takes over when the first tab is closed. The searches do not count for the speed estimate that
  games use, since other tabs of the app share it.
- **Battery:** it pauses while the Battery Status API reports no charging (Chromium only); this
  also keeps it away from Chrome's Energy Saver, which freezes busy hidden tabs.
- **The list:** every analyzed position with its line from move 1, the engine's move, score,
  depth and nodes, in the key-value store under `explore-log/`. Newest first, 300 rows until
  "Show all".

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
