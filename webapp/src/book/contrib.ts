// Opening book contributions (DESIGN.md, "Contributions"): what the app and the server share.
// A browser has its own ECDSA P-256 key pair; the server knows the public key and identifies the
// browser by a short device code derived from it. Requests are signed JSON bodies. Uses Web
// Crypto, so it runs in the browser and in Node alike.
import type { BookEntry } from "./book-logic.ts";

/** Only searches at least this deep are sent. */
export const CONTRIB_MIN_NODES = 50_000_000;
/** Entries per request. */
export const CONTRIB_BATCH = 500;
/** Entries per user and day the server takes. */
export const CONTRIB_DAILY_LIMIT = 5000;

export type DeviceState = "pending" | "approved" | "revoked" | "unknown";

/** POST register: no signature (the server does not know the key yet). */
export interface RegisterRequest {
  publicKey: string;
  name: string;
}

export interface StatusReply {
  code: string;
  state: DeviceState;
  /** Set once approved. */
  user?: string;
  /** Moves of this user that went into the master book (counted when it is published). */
  improvements?: number;
  /** Moves of this user the server has taken, on all their devices. */
  received?: number;
}

/** Signed: POST status with { device }, POST submit with { device, entries }. */
export interface SignedBody {
  device: string;
  entries?: BookEntry[];
}

export interface SubmitReply {
  /** Ids the server is done with: stored, already known or refused. The rest is sent again later. */
  taken: string[];
  accepted: number;
  refused: number;
  /** The daily limit was reached; the rest waits. */
  limited: boolean;
}

/** The header that carries the signature (base64url) of the request body. */
export const SIGNATURE_HEADER = "x-signature";

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

export function toBase64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** A new key pair; the private key cannot be exported, only used to sign. */
export function generateDeviceKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDSA, false, ["sign", "verify"]);
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

/** The public key, or null if the text is not a P-256 public key. */
export async function importPublicKey(text: string): Promise<CryptoKey | null> {
  try {
    const raw = fromBase64url(text);
    if (raw.length !== 65) return null;
    return await crypto.subtle.importKey("raw", raw as BufferSource, ECDSA, true, ["verify"]);
  } catch {
    return null;
  }
}

const BASE32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1

/** Short code for a public key: 8 characters from its SHA-256, e.g. "K7QF-2M9X". */
export async function deviceCode(publicKey: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64url(publicKey) as BufferSource));
  let bits = 0;
  let value = 0;
  let code = "";
  for (const b of hash) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && code.length < 8) {
      code += BASE32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (code.length === 8) break;
  }
  return code.slice(0, 4) + "-" + code.slice(4);
}

/** Normalizes a code as typed by a person: upper case, dash added. */
export function normalizeCode(text: string): string {
  const c = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? c.slice(0, 4) + "-" + c.slice(4) : text;
}

export async function sign(privateKey: CryptoKey, body: string): Promise<string> {
  return toBase64url(new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, new TextEncoder().encode(body))));
}

export async function verify(publicKey: CryptoKey, body: string, signature: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(SIGN, publicKey, fromBase64url(signature) as BufferSource, new TextEncoder().encode(body));
  } catch {
    return false;
  }
}
