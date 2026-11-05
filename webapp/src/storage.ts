// IndexedDB (data lives on this device only): a key-value store for settings and the saved
// game, the opening book's own store, and the outbox of book entries waiting to be sent.

const DB_NAME = "dark-c-helmet";
const KV = "kv";
export const BOOK_STORE = "book";
export const OUTBOX_STORE = "outbox";

let dbPromise: Promise<IDBDatabase> | null = null;

export function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (e.oldVersion < 1) d.createObjectStore(KV);
      if (e.oldVersion < 2) d.createObjectStore(BOOK_STORE, { keyPath: "id" }).createIndex("key", "key");
      if (e.oldVersion < 3) d.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Runs one request in a transaction on `store` and resolves with its result. */
export function request<T>(store: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = op(d.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function load<T>(key: string): Promise<T | undefined> {
  try {
    return await request<T | undefined>(KV, "readonly", (s) => s.get(key));
  } catch {
    return undefined; // storage unavailable (e.g. private mode): start fresh
  }
}

export async function save(key: string, value: unknown): Promise<void> {
  try {
    await request(KV, "readwrite", (s) => s.put(value, key));
  } catch {
    // not persisted; the app keeps working
  }
}

/** The values of all keys that start with `prefix`, in key order. */
export async function loadAll<T>(prefix: string): Promise<T[]> {
  try {
    return await request<T[]>(KV, "readonly", (s) => s.getAll(IDBKeyRange.bound(prefix, prefix + "\uffff")));
  } catch {
    return [];
  }
}

/** Removes all keys that start with `prefix`. */
export async function removeAll(prefix: string): Promise<void> {
  await request(KV, "readwrite", (s) => s.delete(IDBKeyRange.bound(prefix, prefix + "\uffff"))).catch(() => {});
}
