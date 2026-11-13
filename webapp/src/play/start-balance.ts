// How balanced a Chess960 or Chess 960² start is, in one plain sentence (Chess960 start X is the
// 960² pair X/X). The engine's score of every pair (centipawns for White, one signed byte per
// pair at White's number × 960 + Black's, clamped to ±127) is in public/960sq/scores.i8, made
// by tools/eval-960sq.ts --export-scores. The app asks for the one byte it needs (an HTTP range
// request); a server without ranges sends the whole file, which is then kept.
//
// The yardstick is the normal chess start, not 0.00: players know it as fair, and the engine
// gives it +0.15 (pair 518 × 518 in the same file, same search). So a 960² start at +0.15 reads
// "as balanced as normal chess" and one at 0.00 "a little better for Black than usual".
// Differences under about 0.10 are noise, so the middle band is ±0.15 wide around it.

const PAIRS = 960 * 960;
const URL_PATH = "960sq/scores.i8";

/** The engine's score of the normal chess start, in the same file. */
export const STANDARD_START_CP = 15;

export interface Balance {
  /** Band from White's point of view: 2 clearly better for White … -2 better for Black. */
  band: -2 | -1 | 0 | 1 | 2;
  sentence: string;
}

/** The sentence for a score in centipawns for White. */
export function balanceOf(cp: number): Balance {
  const d = cp - STANDARD_START_CP;
  if (d >= 40) return { band: 2, sentence: "White starts with a clear edge here, more than in normal chess. Black will have a hard time defending." };
  if (d >= 15) return { band: 1, sentence: "A little better for White than the normal chess start." };
  if (d > -15) return { band: 0, sentence: "About as balanced as the normal chess start." };
  if (d > -40) return { band: -1, sentence: "A little better for Black than the normal chess start: White's first-move edge is gone." };
  return { band: -2, sentence: "Black is better off than White here, even though White moves first." };
}

/** "+0.32" or "-0.05": the score as pawns for White. */
export function formatPawns(cp: number): string {
  return `${cp < 0 ? "-" : "+"}${(Math.abs(cp) / 100).toFixed(2)}`;
}

let whole: Promise<Int8Array | null> | null = null;
const cache = new Map<number, Promise<number | null>>();

function fileUrl(): URL {
  return new URL(URL_PATH, new URL(import.meta.env.BASE_URL, location.href));
}

async function fetchScore(i: number): Promise<number | null> {
  if (whole) {
    const all = await whole;
    return all ? all[i] : null;
  }
  const r = await fetch(fileUrl(), { headers: { Range: `bytes=${i}-${i}` } });
  if (r.status === 206) {
    const b = new Int8Array(await r.arrayBuffer());
    return b.length === 1 ? b[0] : null;
  }
  if (!r.ok) return null;
  // No range support: keep the whole file (the dev server's index.html is the wrong size).
  whole = r.arrayBuffer().then((buf) => (buf.byteLength === PAIRS ? new Int8Array(buf) : null));
  const all = await whole;
  return all ? all[i] : null;
}

/** The engine's score of a Chess 960² start in centipawns for White, null when unknown. */
export function startScore(white: number, black: number): Promise<number | null> {
  const i = white * 960 + black;
  let p = cache.get(i);
  if (!p) {
    p = fetchScore(i).catch(() => null);
    p.then((v) => v === null && cache.delete(i)); // try again next time
    cache.set(i, p);
  }
  return p;
}
