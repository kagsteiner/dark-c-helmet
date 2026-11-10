// The "Sync my devices" part of the Settings screen: off → create a code or enter one → confirm
// what will be merged → on (the code, stop, delete).
import { completeWord, parseCode, suggestWords } from "../sync/code.ts";
import {
  createSyncCode,
  deleteSyncData,
  linkDevice,
  localCounts,
  onSyncChange,
  peekCode,
  stopSync,
  syncNow,
  syncState,
  SyncError,
  type Counts,
} from "../sync/client.ts";

type Mode = { name: "main" } | { name: "enter" } | { name: "confirm"; code: string; text: string } | { name: "delete" };

const plural = (n: number, one: string) => `${n.toLocaleString("en")} ${one}${n === 1 ? "" : "s"}`;
const describe = (c: Counts) =>
  c.bookmarks ? `${plural(c.results, "result")} and ${plural(c.bookmarks, "bookmark")}` : plural(c.results, "result");
const isEmpty = (c: Counts) => c.results === 0 && c.bookmarks === 0;

function mergeText(local: Counts, remote: Counts): string {
  if (isEmpty(local) && isEmpty(remote)) return "This device and this code have no results or bookmarks yet.";
  if (isEmpty(local)) return `The ${describe(remote)} under this code will be added to this device.`;
  if (isEmpty(remote)) return `This device's ${describe(local)} will be stored under this code.`;
  return `This device's ${describe(local)} will be added to the ${describe(remote)} under this code.`;
}

export function mountSyncSection(root: HTMLElement): () => void {
  let mode: Mode = { name: "main" };

  const button = (action: string, label: string) => `<button class="btn-secondary" type="button" data-sync="${action}">${label}</button>`;
  const statusLine = `<p class="sync-status small" aria-live="polite"></p>`;
  const status = (text: string, error = false) => {
    const el = root.querySelector(".sync-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("error", error);
  };

  const render = () => {
    const s = syncState();
    if (!s.code && (mode.name === "main" || mode.name === "delete")) {
      root.innerHTML = `
        <p class="small muted">Keep your results, your 960 progress, your bookmarks and your board colours the same on
          all your devices. A code of five words links them, and you need no account. The server stores your results,
          bookmarks and board colours under that code. Games in progress and the other settings stay on each device.</p>
        ${s.deletedElsewhere ? `<p class="small">Sync stopped on this device because the data for its code was deleted from the server.</p>` : ""}
        <div class="book-actions">${button("create", "Create a code")}${button("enter", "I have a code")}</div>
        ${statusLine}`;
    } else if (mode.name === "enter") {
      root.innerHTML = `
        <label class="field">
          <span class="field-label">Your five code words</span>
          <input class="sync-input" name="syncCode" type="text" autocomplete="off" autocapitalize="none" spellcheck="false">
        </label>
        <div class="sync-suggest"></div>
        <div class="book-actions">${button("check", "Continue")}${button("back", "Cancel")}</div>
        ${statusLine}`;
      root.querySelector<HTMLInputElement>(".sync-input")!.focus();
    } else if (mode.name === "confirm") {
      root.innerHTML = `
        <p>${mode.text}</p>
        <div class="book-actions">${button("link", "Link this device")}${button("back", "Cancel")}</div>
        ${statusLine}`;
    } else if (mode.name === "delete") {
      root.innerHTML = `
        <p>This removes the results and bookmarks under this code from the server and stops sync on all your
          devices. Each device keeps its own copy.</p>
        <div class="book-actions">${button("delete-yes", "Delete from the server")}${button("back", "Cancel")}</div>
        ${statusLine}`;
    } else {
      const last = s.last ? `Last synced ${new Date(s.last).toLocaleString()}.` : "";
      root.innerHTML = `
        <p>Your code: <strong class="sync-code">${s.code!.replaceAll("-", " ")}</strong></p>
        <p class="small muted">To add a device, choose “I have a code” there and type these words. Each browser
          keeps its own data, and so does an app added to the home screen, so link each one you use. Keep the
          words to yourself: they give access to your results and bookmarks.</p>
        <p class="small muted">${last}</p>
        <div class="book-actions">${button("now", "Sync now")}${button("copy", "Copy code")}</div>
        <div class="book-actions">${button("stop", "Stop syncing on this device")}${button("delete", "Delete my data from the server")}</div>
        ${statusLine}`;
    }
  };

  const go = (next: Mode) => {
    mode = next;
    render();
  };

  const prepareLink = async (code: string) => {
    const [local, remote] = await Promise.all([localCounts(), peekCode(code)]);
    go({ name: "confirm", code, text: mergeText(local, remote) });
  };

  const notFound = "There is no data under this code. Please check the words.";

  const check = async () => {
    const parsed = parseCode(root.querySelector<HTMLInputElement>(".sync-input")!.value);
    if ("error" in parsed) return status(parsed.error, true);
    try {
      await prepareLink(parsed.code);
    } catch (err) {
      status(err instanceof SyncError && err.status === 404 ? notFound : (err as Error).message, true);
    }
  };

  const onClick = async (ev: Event) => {
    const action = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-sync]")?.dataset.sync;
    const word = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-word]")?.dataset.word;
    if (word) {
      const input = root.querySelector<HTMLInputElement>(".sync-input")!;
      input.value = completeWord(input.value, word);
      input.focus();
      root.querySelector(".sync-suggest")!.replaceChildren();
      return;
    }
    if (!action) return;
    status("");
    try {
      if (action === "create") {
        await createSyncCode();
        go({ name: "main" });
      } else if (action === "enter") go({ name: "enter" });
      else if (action === "back") go({ name: "main" });
      else if (action === "check") await check();
      else if (action === "link" && mode.name === "confirm") {
        await linkDevice(mode.code);
        go({ name: "main" });
      } else if (action === "now") {
        await syncNow();
        status("Synced.");
      } else if (action === "copy") {
        await navigator.clipboard.writeText(syncState().code!.replaceAll("-", " "));
        status("Code copied.");
      } else if (action === "stop") {
        await stopSync();
        go({ name: "main" });
      } else if (action === "delete") go({ name: "delete" });
      else if (action === "delete-yes") {
        await deleteSyncData();
        go({ name: "main" });
      }
    } catch (err) {
      status(err instanceof SyncError && err.status === 404 ? notFound : (err as Error).message, true);
    }
  };

  const onInput = (ev: Event) => {
    const input = ev.target as HTMLInputElement;
    if (!input.classList.contains("sync-input")) return;
    root.querySelector(".sync-suggest")!.innerHTML = suggestWords(input.value)
      .map((w) => `<button class="btn-secondary" type="button" data-word="${w}">${w}</button>`)
      .join("");
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Enter" && (ev.target as HTMLElement).classList.contains("sync-input")) {
      ev.preventDefault();
      check();
    }
  };

  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("keydown", onKey);
  const unsubscribe = onSyncChange(() => {
    if (mode.name === "main") {
      const message = root.querySelector(".sync-status")?.textContent ?? "";
      render();
      status(message);
    }
  });
  render();

  return () => {
    unsubscribe();
    root.removeEventListener("click", onClick);
    root.removeEventListener("input", onInput);
    root.removeEventListener("keydown", onKey);
  };
}
