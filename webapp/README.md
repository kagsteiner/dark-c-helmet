# Dark C. Helmet — web app

Play and analyze with the Dark C. Helmet engine in the browser. The engine runs on the
device as WebAssembly; games, the opening book and settings are stored in the browser.
Decisions: `DESIGN.md`. Work plan: `BACKLOG.md`.

## Commands

Run in this folder (needs Node and Emscripten's `emcc`):

```bash
npm install          # once
npm run engine       # build the WebAssembly modules into public/engine/
npm run dev          # development server on http://localhost:5173
npm test             # unit tests (rules, SAN, clocks, review, book)
npm run build        # production build into dist/
```

`engine-test.html` (also in the build) checks the engine in a browser: `uci`, `bench`,
threads, stop, and perft of the rules module.

## Seed book

`tools/seed-book.ts` builds an opening book with the native engine (`make` in the project
root first), one single-threaded engine per core. Load the result in the app with
Book → Merge from file. It runs in batches: `--hours 1.5` stops it by itself (or press
Ctrl-C), and the same command resumes where it stopped. Each batch adds the earliest
positions still missing, so the book is useful after every batch.

```bash
node tools/seed-book.ts --out ~/chess-data/seed-standard.json --hours 1.5
node tools/seed-book.ts --out ~/chess-data/seed-960.json --variant chess960 --positions all --widths 2,2,2,2 --max-move 10
```

Options are described at the top of the file. Book files belong outside OneDrive.

## Master book

The master book is the published seed book: the app checks `book/manifest.json` next to it
at startup and offers to merge a newer version (or merges it by itself, a setting on the
Book screen). `tools/publish-book.ts` merges the seed files, writes a new numbered version
(compact JSON, gzip) and with `--upload` copies it to the server:

```bash
node webapp/tools/publish-book.ts --in ~/chess-data/seed-standard.json --in ~/chess-data/seed-960.json \
  --dir ~/chess-data/master-book --upload vps:nodejs/chess/book
```

`deploy.sh` leaves the server's `book/` folder alone.

## Book contributions

Browsers you approve send their deep searches (at least 50 million nodes) to a small server
on the VPS; you publish the master book there. Details in `DESIGN.md`, "Contributions".

```bash
sh server/deploy.sh                                   # build and (re)start the server (pm2: chess-api)
ssh vps ~/nodejs/chess-api/book-admin pending         # browsers waiting, with their codes
ssh vps ~/nodejs/chess-api/book-admin approve K7QF-2M9X --user fred
ssh vps ~/nodejs/chess-api/book-admin publish         # new master book version from all inputs
ssh vps ~/nodejs/chess-api/book-admin users           # moves each user added
rsync ~/chess-data/seed-standard.json vps:chess-data/seed/   # a seed book as input
```

Locally: `npm run server` (data in `server/.data/`) next to `npm run dev`.

## Deploying

```bash
DEPLOY_TARGET=user@host:/var/www/dark-c-helmet sh deploy/deploy.sh
```

The web server must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, and the page must be served over HTTPS;
otherwise the engine runs single-threaded. `deploy/nginx.conf` has a configuration.
