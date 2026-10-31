// The master opening book on the server (book/manifest.json next to the app): checking for a
// newer version, merging it, and the question shown at startup.
import { settings } from "../settings.ts";
import { load, save } from "../storage.ts";
import { mergeEntries, type MergeResult } from "./book.ts";
import { fromMasterFile, isManifest, type MasterManifest } from "./master-format.ts";

const INSTALLED_KEY = "master-book";
const DISMISSED_KEY = "master-book-dismissed";

export interface InstalledMaster {
  version: number;
  moves: number;
  /** ISO date of the version (when it was published) */
  created: string;
}

function bookUrl(file: string): string {
  return new URL("book/" + file, new URL(import.meta.env.BASE_URL, location.href)).href;
}

/** The server's manifest, or null if there is none (or the server cannot be reached). */
export async function fetchManifest(): Promise<MasterManifest | null> {
  try {
    const r = await fetch(bookUrl("manifest.json"), { cache: "no-cache" });
    if (!r.ok) return null;
    const m: unknown = await r.json();
    return isManifest(m) ? m : null;
  } catch {
    return null;
  }
}

export function installedMaster(): Promise<InstalledMaster | undefined> {
  return load<InstalledMaster>(INSTALLED_KEY);
}

/** Downloads a master book version and merges it into this device's book. */
export async function mergeMaster(m: MasterManifest, onProgress?: (fraction: number) => void): Promise<MergeResult> {
  const r = await fetch(bookUrl(m.file));
  if (!r.ok || !r.body) throw new Error(`The opening book could not be downloaded (${r.status}).`);
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(Math.min(1, loaded / m.bytes));
  }
  // Unpack unless the server already did (some send .gz files with Content-Encoding: gzip).
  const blob = new Blob(chunks as BlobPart[]);
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gzipped = head[0] === 0x1f && head[1] === 0x8b;
  const text = await new Response(gzipped ? blob.stream().pipeThrough(new DecompressionStream("gzip")) : blob).text();
  const result = await mergeEntries(fromMasterFile(JSON.parse(text)));
  await save(INSTALLED_KEY, { version: m.version, moves: m.moves, created: m.created } satisfies InstalledMaster);
  return result;
}

export function formatBytes(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function describeMerge(r: MergeResult): string {
  const n = (k: number) => k.toLocaleString("en");
  return `${n(r.added)} moves added, ${n(r.updated)} replaced by deeper searches, ${n(r.kept)} kept.`;
}

/** At startup: if the server has a newer master book, merge it (setting) or ask once per version. */
export async function checkMasterAtStartup(onMerged: () => void): Promise<void> {
  const m = await fetchManifest();
  const installed = await installedMaster();
  if (!m || m.version <= (installed?.version ?? 0)) return;
  if (settings().autoMergeMaster) {
    await mergeMaster(m).catch(() => {});
    onMerged();
    return;
  }
  if ((await load<number>(DISMISSED_KEY)) === m.version) return; // "Later" for this version
  askToMerge(m, onMerged);
}

function askToMerge(m: MasterManifest, onMerged: () => void): void {
  const dialog = document.createElement("dialog");
  dialog.className = "sheet";
  dialog.innerHTML = `
    <div class="sheet-body">
      <h2 class="title">New opening book</h2>
      <p>Version ${m.version} of the master opening book is available: ${m.moves.toLocaleString("en")} moves
        (${formatBytes(m.bytes)} to download). Merge it into your book? Moves you already have
        from deeper searches are kept.</p>
      <p class="master-ask-status small muted" aria-live="polite"></p>
      <div class="sheet-actions">
        <button class="btn-secondary" data-action="later">Later</button>
        <button class="btn-primary" data-action="merge">Merge</button>
      </div>
    </div>`;
  document.body.append(dialog);
  const status = dialog.querySelector<HTMLElement>(".master-ask-status")!;
  const later = dialog.querySelector<HTMLButtonElement>('[data-action="later"]')!;
  const merge = dialog.querySelector<HTMLButtonElement>('[data-action="merge"]')!;
  later.addEventListener("click", () => {
    save(DISMISSED_KEY, m.version); // the Book screen still offers it
    dialog.close();
  });
  merge.addEventListener("click", async () => {
    merge.disabled = later.disabled = true;
    try {
      const r = await mergeMaster(m, (f) => (status.textContent = `Downloading… ${Math.round(f * 100)}%`));
      status.textContent = "Merged: " + describeMerge(r);
      onMerged();
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
      status.classList.add("error");
    }
    merge.hidden = true;
    later.textContent = "Close";
    later.disabled = false;
    later.onclick = () => dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}
