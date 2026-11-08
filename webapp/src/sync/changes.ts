// Tells the sync client that something worth syncing changed on this device. A module of its own
// so that the data modules need not know about the client.

/** The storage key of the flag "the Fischer easter egg has been shown". */
export const EGG_KEY = "egg:fischer";

const listeners = new Set<() => void>();

export function onLocalChange(listener: () => void): void {
  listeners.add(listener);
}

export function notifyLocalChange(): void {
  for (const l of listeners) l();
}
