// Sync codes: five words from a list of 2,048 (55 bits), e.g. "famous-river-among-seven-table".
import { WORDS } from "./wordlist.ts";

export const CODE_WORDS = 5;

const byPrefix = new Map(WORDS.map((w) => [w.slice(0, 4), w]));

export function generateCode(): string {
  const random = crypto.getRandomValues(new Uint16Array(CODE_WORDS));
  return Array.from(random, (r) => WORDS[r & 2047]).join("-");
}

/** The list word meant by `typed`: the word itself, or its first four letters or more. */
function resolveWord(typed: string): string | undefined {
  const word = byPrefix.get(typed.slice(0, 4));
  return word?.startsWith(typed) && typed.length >= Math.min(4, word.length) ? word : undefined;
}

export type ParsedCode = { code: string } | { error: string };

/** Reads a typed code; capitals and any separators between the words are fine. */
export function parseCode(input: string): ParsedCode {
  const typed = input.toLowerCase().match(/[a-z]+/g) ?? [];
  const words: string[] = [];
  for (const t of typed) {
    const word = resolveWord(t);
    if (!word) return { error: `“${t}” is not one of the code words.` };
    words.push(word);
  }
  if (words.length !== CODE_WORDS) return { error: `A code has ${CODE_WORDS} words. This one has ${words.length}.` };
  return { code: words.join("-") };
}

/** Up to `limit` list words that start with the word being typed at the end of `input`. */
export function suggestWords(input: string, limit = 4): string[] {
  const last = input.toLowerCase().match(/[a-z]+$/)?.[0];
  if (!last) return [];
  return WORDS.filter((w) => w.startsWith(last) && w !== last).slice(0, limit);
}

/** `input` with the word being typed replaced by `word`, ready for the next one. */
export function completeWord(input: string, word: string): string {
  const done = input.replace(/[a-zA-Z]+$/, "") + word;
  return (done.match(/[a-z]+/gi) ?? []).length < CODE_WORDS ? done + " " : done;
}
