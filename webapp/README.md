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

## Deploying

```bash
DEPLOY_TARGET=user@host:/var/www/dark-c-helmet sh deploy/deploy.sh
```

The web server must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, and the page must be served over HTTPS;
otherwise the engine runs single-threaded. `deploy/nginx.conf` has a configuration.
