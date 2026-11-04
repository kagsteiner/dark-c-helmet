// book-admin: approving browsers that may contribute to the opening book, and publishing it.
// On the VPS:  ~/nodejs/chess-api/book-admin <command>   (DESIGN.md, "Contributions")
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeCode } from "../src/book/contrib.ts";
import { publish } from "./publish.ts";
import { Store, type Device } from "./store.ts";

const USAGE = `usage: book-admin <command>
  pending                          browsers waiting for approval
  approve <code> --user <name>     let a browser contribute, counted for <name>
  revoke <code> | --user <name>    stop a browser, or all browsers of a user
  devices                          all browsers
  users                            moves each user added to the master book
  publish                          build a new master book version from all inputs

Data: CHESS_DATA (default ~/chess-data); book: CHESS_BOOK (default ~/nodejs/chess/book).`;

const store = new Store();
const bookDir = process.env.CHESS_BOOK ?? join(homedir(), "nodejs", "chess", "book");
const [command, ...args] = process.argv.slice(2);

function option(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const date = (iso?: string) => (iso ? iso.slice(0, 10) : "");
const describe = (d: Device) =>
  `${d.code}  ${d.state.padEnd(8)}  ${(d.user ?? "").padEnd(12)}  ${date(d.registered)}  ${d.name || "(no name)"}`;

switch (command) {
  case "pending": {
    const list = store.pending();
    if (!list.length) console.log("No browsers waiting.");
    for (const d of list) console.log(describe(d));
    break;
  }
  case "devices": {
    const list = store.devices().sort((a, b) => a.registered.localeCompare(b.registered));
    if (!list.length) console.log("No browsers registered.");
    for (const d of list) console.log(describe(d));
    break;
  }
  case "approve": {
    const code = normalizeCode(args[0] ?? "");
    const user = option("--user")?.trim();
    if (!user || !/^[\w .'-]{1,30}$/u.test(user)) fail("approve <code> --user <name> (letters, digits, space . ' -; up to 30)");
    const d = store.device(code) ?? fail(`No browser with code ${code} (pending ones expire after 7 days).`);
    d.state = "approved";
    d.user = user;
    d.approved = new Date().toISOString();
    delete d.revoked;
    store.saveDevice(d);
    const users = store.users();
    if (!users[user]) {
      users[user] = { improvements: 0, created: d.approved };
      store.saveUsers(users);
    }
    console.log(`Approved ${code} (${d.name || "no name"}) for ${user}.`);
    break;
  }
  case "revoke": {
    const user = option("--user");
    const list = user ? store.devices().filter((d) => d.user === user) : [store.device(normalizeCode(args[0] ?? "")) ?? fail("No such browser.")];
    if (!list.length) fail(`No browsers of ${user}.`);
    for (const d of list) {
      d.state = "revoked";
      d.revoked = new Date().toISOString();
      store.saveDevice(d);
      console.log(`Revoked ${d.code} (${d.name || "no name"}, ${d.user ?? "no user"}).`);
    }
    console.log("Their moves leave the master book with the next publish.");
    break;
  }
  case "users": {
    const users = Object.entries(store.users()).sort((a, b) => b[1].improvements - a[1].improvements);
    if (!users.length) console.log("No users yet.");
    for (const [name, u] of users) {
      const devices = store.devices().filter((d) => d.user === name && d.state === "approved").length;
      console.log(`${name.padEnd(16)} ${String(u.improvements).padStart(8)} moves   ${devices} browser(s)`);
    }
    break;
  }
  case "publish": {
    const r = publish(store, bookDir);
    const m = r.manifest;
    console.log(
      `Master book version ${m.version}: ${m.positions.toLocaleString("en")} positions, ${m.moves.toLocaleString("en")} moves, ` +
        `${(m.bytes / 1e6).toFixed(2)} MB, in ${bookDir}`,
    );
    console.log(`Inputs: ${r.seedMoves.toLocaleString("en")} seed moves, ${r.contributed.toLocaleString("en")} contributed.`);
    const counted = Object.entries(r.improvements);
    console.log(counted.length ? "Added or deepened: " + counted.map(([u, n]) => `${u} ${n}`).join(", ") : "No new contributions.");
    break;
  }
  default:
    console.log(USAGE);
    if (command && command !== "help") process.exit(1);
}
