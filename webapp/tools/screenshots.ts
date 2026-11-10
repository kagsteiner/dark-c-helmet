// Screenshots of the app for about.html, made with the installed Chrome (headless, an empty
// profile, no extra packages). The profile gets made-up results and bookmarks first, so the
// Progress screen and the bookmark list look lived-in. Run again whenever the app changes.
//
// Usage (from webapp/):
//   node tools/screenshots.ts                          # the live app at https://darkhelmet.eu
//   node tools/screenshots.ts --url http://localhost:4173/   # `npm run preview` of a fresh build
// Options:
//   --url URL      the app (default https://darkhelmet.eu/)
//   --out DIR      where the WebP files go (default public/screenshots)
//   --only NAME    one screenshot only (see SHOTS below)
//   --chrome PATH  Chrome (default the macOS application)
// Needs cwebp (brew install webp).

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "");
const URL_BASE = args.get("url") ?? "https://darkhelmet.eu/";
const OUT = args.get("out") ?? "public/screenshots";
const ONLY = args.get("only");
const CHROME = args.get("chrome") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// --- a minimal Chrome DevTools Protocol client -------------------------------------------------

type Json = Record<string, unknown>;

class Page {
  private next = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message}`));
      else p.resolve(msg.result);
    });
  }

  send(method: string, params: Json = {}): Promise<Json> {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
      result: { value: T };
      exceptionDetails?: { exception?: { description?: string }; text: string };
    };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async waitFor(expression: string, what: string, ms = 30_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await this.eval<boolean>(`!!(${expression})`).catch(() => false)) return;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /** A full page load (going through about:blank, since a change after "#" alone loads nothing). */
  async go(url: string): Promise<void> {
    await this.send("Page.navigate", { url: "about:blank" });
    await this.waitFor(`location.href === "about:blank"`, "a blank page");
    await this.send("Page.navigate", { url });
    await this.waitFor(`document.readyState === "complete" && document.querySelector(".topbar")`, `the app at ${url}`);
  }

  async viewport(width: number, height: number, mobile = false, scale = 2): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile });
  }

  /** OUT/name.webp: the viewport, or the part `clip` (a JS expression giving
   *  {x, y, width, height} in CSS pixels). */
  async shoot(name: string, clip?: string): Promise<void> {
    await this.eval(`document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 300))))`);
    const params: Json = { format: "png" };
    if (clip) params.clip = { ...(await this.eval<Json>(`(() => { const c = ${clip}; return { x: c.x, y: c.y, width: c.width, height: c.height }; })()`)), scale: 1 };
    const { data } = (await this.send("Page.captureScreenshot", params)) as { data: string };
    const png = join(tmp, `${name}.png`);
    writeFileSync(png, Buffer.from(data, "base64"));
    const webp = join(OUT, `${name}.webp`);
    execFileSync("cwebp", ["-quiet", "-q", "85", png, "-o", webp]);
    console.log(`wrote ${webp}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- made-up data ------------------------------------------------------------------------------

/** Same random numbers on every run, so the pictures only change when the app does. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12);

/** Results of a keen player: about half the starts played per colour, most won against 1300,
 *  fewer against 1600, a few against the engine. */
function demoRecords(): Json[] {
  const rnd = random(960);
  const records: Json[] = [];
  const opponents = ["1300", "1600", "engine"];
  let id = 0;
  for (let n = 0; n < 960; n++) {
    for (const [side, chance] of [["w", 0.55], ["b", 0.45]] as const) {
      if (rnd() >= chance) continue;
      const r = rnd();
      const level = r < 0.22 ? 0 : r < 0.62 ? 1 : r < 0.88 ? 2 : 3;
      const opponent = level === 0 ? opponents[Math.floor(rnd() * 3)] : opponents[level - 1];
      records.push({
        id: `demo${id++}`,
        started: NOW - Math.floor(rnd() * 120 * DAY),
        chess960: true,
        position960: n,
        human: side,
        opponent,
        tc: { kind: "game", minutes: 5, increment: 0 },
        outcome: level === 0 ? "loss" : "win",
        star: level === 3 && rnd() < 0.5 ? "silver" : "gold",
        plies: 40 + Math.floor(rnd() * 80),
      });
    }
  }
  return records;
}

/** Bookmarks with the player's own notes; the last one is a Chess 960² start. */
const DEMO_BOOKMARKS = [
  { white: 0, black: 0, added: NOW - 41 * DAY, note: "Both bishops on one side. Lost three times in a row." },
  { white: 347, black: 347, added: NOW - 23 * DAY, note: "Fun attack on the long diagonal" },
  { white: 703, black: 703, added: NOW - 9 * DAY },
  { white: 128, black: 845, added: NOW - 2 * DAY, note: "960²: White's king is so exposed" },
].map((b) => ({ ...b, changed: b.added }));

/** Writes the demo data into the app's database (storage.ts: kv store, value under its key). */
function seedScript(): string {
  const entries: [string, unknown][] = [
    ...demoRecords().map((r) => [`game:${r.id}`, r] as [string, unknown]),
    ["bookmarks", DEMO_BOOKMARKS],
    // No question about merging the master book in the pictures.
    ["master-book", { version: 9999, moves: 0, created: new Date(NOW).toISOString() }],
    ["new-game-choices", { opponent: "engine", variant: "chess960", start960: "bookmark", bookmark: "347-347", color: "w", tcKind: "increment", incMinutes: 10, incSeconds: 5, extraSeconds: 30 }],
  ];
  return `new Promise((resolve, reject) => {
    const req = indexedDB.open("dark-c-helmet");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("kv", "readwrite");
      const kv = tx.objectStore("kv");
      for (const [key, value] of ${JSON.stringify(entries)}) kv.put(value, key);
      tx.oncomplete = () => { req.result.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
  })`;
}

// --- the screenshots ---------------------------------------------------------------------------

const SHOTS: Record<string, (page: Page) => Promise<void>> = {
  async progress(page) {
    await page.viewport(1000, 1180);
    await page.go(URL_BASE + "#/progress");
    await page.waitFor(`/[1-9]\\d* played/.test(document.querySelector(".pg-stats")?.textContent ?? "")`, "the demo results");
    // The progress section with a small margin.
    await page.shoot("progress", `(() => { const r = document.querySelector(".progress").getBoundingClientRect();
      return { x: r.left - 24, y: r.top, width: r.width + 48, height: r.height + 8 }; })()`);
  },

  async "new-game-bookmarks"(page) {
    await page.viewport(1000, 1500);
    await page.go(URL_BASE + "#/play");
    await page.waitFor(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "New game")`, "the New game button");
    await page.eval(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "New game").click()`);
    await page.waitFor(`document.querySelector(".bm-list .bm-text")`, "the bookmark list");
    // The dialog alone, without the dimmed board behind it.
    await page.shoot("new-game-bookmarks", `document.querySelector('[aria-label="New game"]').getBoundingClientRect()`);
  },
};

// --- run ---------------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "dch-shots-"));
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(tmp, "profile")}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--lang=en-US", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

try {
  const port = await new Promise<string>((resolve, reject) => {
    let err = "";
    chrome.stderr!.on("data", (d) => {
      err += d;
      const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (m) resolve(m[1]);
    });
    chrome.on("exit", () => reject(new Error("Chrome stopped: " + err)));
  });
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const socket = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener("open", r, { once: true }));
  const page = new Page(socket);
  await page.send("Page.enable");
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  // English dates and times, whatever this Mac is set to.
  await page.send("Emulation.setLocaleOverride", { locale: "en-US" });
  await page.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Berlin" });

  // First visit creates the database; then the demo data goes in.
  await page.viewport(1000, 900);
  await page.go(URL_BASE + "#/progress");
  await page.eval(seedScript());

  for (const [name, shot] of Object.entries(SHOTS)) {
    if (ONLY && ONLY !== name) continue;
    await shot(page);
  }
  socket.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
