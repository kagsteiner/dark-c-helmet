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
Book → Merge from file. It can be stopped (Ctrl-C) and resumed with the same command.

```bash
node tools/seed-book.ts --out ~/chess-data/seed-standard.json
node tools/seed-book.ts --out ~/chess-data/seed-960.json --variant chess960 --positions all --widths 2,2,2,2 --max-move 10
```

Options are described at the top of the file. Book files belong outside OneDrive.

## Deploying

```bash
DEPLOY_TARGET=user@host:/var/www/dark-c-helmet sh deploy/deploy.sh
```

The web server must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, and the page must be served over HTTPS;
otherwise the engine runs single-threaded. `deploy/nginx.conf` has a configuration.
