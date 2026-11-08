// The Chess 960² starts that the engine found balanced: one bit per pair (White's number × 960 +
// Black's), 115,200 bytes, made by tools/eval-960sq.ts. Without the file every pair is allowed.

const PAIRS = 960 * 960;
const URL_PATH = "960sq/balanced.bin";

let list: Promise<Uint8Array | null> | null = null;

function loadList(): Promise<Uint8Array | null> {
  list ??= fetch(new URL(URL_PATH, new URL(import.meta.env.BASE_URL, location.href)))
    .then(async (r) => {
      if (!r.ok) return null;
      const bytes = new Uint8Array(await r.arrayBuffer());
      return bytes.length === PAIRS / 8 ? bytes : null; // e.g. the dev server's index.html
    })
    .catch(() => null);
  return list;
}

export function isBalanced(bits: Uint8Array | null, white: number, black: number): boolean {
  if (!bits) return true;
  const i = white * 960 + black;
  return (bits[i >> 3] & (1 << (i & 7))) !== 0;
}

/** A random pair from the bitmap (any pair without one). `random` in [0, 1). */
export function pickPair(bits: Uint8Array | null, random: () => number = Math.random): [number, number] {
  let count = 0;
  if (bits) for (const b of bits) for (let x = b; x; x &= x - 1) count++;
  if (!count) {
    const i = Math.floor(random() * PAIRS);
    return [Math.floor(i / 960), i % 960];
  }
  let k = Math.floor(random() * count);
  for (let byte = 0; byte < bits!.length; byte++) {
    for (let x = bits![byte]; x; x &= x - 1) {
      if (k-- === 0) {
        const i = byte * 8 + (31 - Math.clz32(x & -x));
        return [Math.floor(i / 960), i % 960];
      }
    }
  }
  throw new Error("unreachable");
}

/** A random balanced Chess 960² start. */
export async function randomBalancedPair(): Promise<[number, number]> {
  return pickPair(await loadList());
}

/** Is this pair in the balanced list? null when there is no list. */
export async function balancedPair(white: number, black: number): Promise<boolean | null> {
  const bits = await loadList();
  return bits ? isBalanced(bits, white, black) : null;
}
