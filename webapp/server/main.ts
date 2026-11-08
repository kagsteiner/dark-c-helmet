// The contribution server (DESIGN.md, "Contributions"): a small HTTP server on localhost, behind
// nginx at /chess/api/ (which strips that prefix). Started by pm2 on the VPS:
//
//   PORT=3060 node server.mjs           data in ~/chess-data (CHESS_DATA to change it)
//
// No IP addresses are stored or logged.
import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { SIGNATURE_HEADER } from "../src/book/contrib.ts";
import { Api, ApiError } from "./api.ts";
import { loadRules } from "./rules-node.ts";
import { Store } from "./store.ts";
import { SyncApi } from "./sync.ts";

const PORT = Number(process.env.PORT ?? 3060);
const MAX_BODY = 3 << 19; // 1.5 MB: 500 book entries are about 150 KB, a full sync file about 1 MB

// Bundled: the rules module lies in rules/ next to server.mjs. From the sources: public/engine/.
const rulesDir = process.env.RULES_DIR ? pathToFileURL(process.env.RULES_DIR.replace(/\/?$/, "/")) : new URL("./rules/", import.meta.url);
const api = new Api(new Store(), await loadRules(rulesDir));
const sync = new SyncApi();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, "request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  const send = (status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };
  try {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/health") return send(200, { ok: true });
    if (req.method !== "POST") throw new ApiError(405, "POST only");
    const body = await readBody(req);
    const signature = String(req.headers[SIGNATURE_HEADER] ?? "");
    if (path === "/register") return send(200, await api.register(body));
    if (path === "/status") return send(200, await api.status(body, signature));
    if (path === "/submit") return send(200, await api.submit(body, signature));
    if (path === "/sync") return send(200, sync.sync(body));
    if (path === "/sync/peek") return send(200, sync.peek(body));
    if (path === "/sync/delete") return send(200, sync.remove(body));
    throw new ApiError(404, "no such endpoint");
  } catch (err) {
    if (err instanceof ApiError) return send(err.status, { error: err.message });
    console.error(err);
    send(500, { error: "server error" });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`contribution server on 127.0.0.1:${PORT}`));
