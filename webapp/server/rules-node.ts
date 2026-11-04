// The rules module in Node: dh-rules.js and .wasm from a folder (next to the bundle on the VPS,
// public/engine/ in development and tests).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Rules } from "../src/chess/rules.ts";

export function loadRules(dir: URL): Promise<Rules> {
  return Rules.load(dir.href, readFileSync(fileURLToPath(new URL("dh-rules.wasm", dir))));
}
