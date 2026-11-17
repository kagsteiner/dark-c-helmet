// Sharpness of book positions in IndexedDB (filled from the master book, see sharpness.ts).
import { db, request, SHARP_STORE } from "../storage.ts";
import { mergeSharpRecords, type SharpRecord } from "./sharpness.ts";

export async function sharpnessOf(key: string): Promise<SharpRecord | undefined> {
  try {
    return await request<SharpRecord | undefined>(SHARP_STORE, "readonly", (s) => s.get(key));
  } catch {
    return undefined;
  }
}

export async function sharpnessMany(keys: string[]): Promise<Map<string, SharpRecord>> {
  const out = new Map<string, SharpRecord>();
  await Promise.all(
    [...new Set(keys)].map(async (k) => {
      const r = await sharpnessOf(k);
      if (r) out.set(k, r);
    }),
  );
  return out;
}

export async function sharpnessCount(): Promise<number> {
  return request<number>(SHARP_STORE, "readonly", (s) => s.count()).catch(() => 0);
}

/** Merges records: for the same position the one measured with more nodes wins. */
export async function mergeSharpness(incoming: SharpRecord[]): Promise<{ added: number; updated: number; kept: number }> {
  const existing = new Map<string, SharpRecord>(
    (await request<SharpRecord[]>(SHARP_STORE, "readonly", (s) => s.getAll()).catch(() => [])).map((r) => [r.key, r]),
  );
  const before = new Map(existing);
  const result = mergeSharpRecords(existing, incoming);
  const writes = [...existing.values()].filter((r) => before.get(r.key) !== r);
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(SHARP_STORE, "readwrite");
    const store = tx.objectStore(SHARP_STORE);
    for (const r of writes) store.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return result;
}

export async function clearSharpness(): Promise<void> {
  await request(SHARP_STORE, "readwrite", (s) => s.clear()).catch(() => {});
}
