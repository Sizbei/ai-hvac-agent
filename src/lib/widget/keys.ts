import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Widget API keys — the two-key model for the embeddable widget.
 *
 *  - PUBLISHABLE (pk_live_…): ships in the embed snippet, public by design.
 *    Scoped to the bare minimum (create/read a chat session). Resolves which
 *    org a widget belongs to.
 *  - SECRET (sk_live_…): server-side only, shown once, admin scope. Never in
 *    the browser.
 *
 * Keys are stored HASHED (SHA-256) at rest — the plaintext is shown exactly
 * once at creation and is unrecoverable afterward. A short prefix is stored in
 * the clear so the admin can recognize a key in the list.
 */

export const KEY_TYPES = ["publishable", "secret"] as const;
export type KeyType = (typeof KEY_TYPES)[number];

export const KEY_SCOPES = [
  "sessions:create",
  "sessions:read",
  "admin",
] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** Default scopes per key type. Publishable can only start/read a session. */
export const DEFAULT_SCOPES: Record<KeyType, readonly KeyScope[]> = {
  publishable: ["sessions:create", "sessions:read"],
  secret: ["admin"],
};

const PREFIXES: Record<KeyType, string> = {
  publishable: "pk_live_",
  secret: "sk_live_",
};

/** Number of random bytes in the key body (32 bytes → 64 hex chars). */
const KEY_BYTES = 32;
/** How many leading chars (incl. prefix) we keep in cleartext for display. */
const DISPLAY_PREFIX_LEN = 16;

export interface GeneratedKey {
  /** Full plaintext key — returned to the caller ONCE, never stored. */
  readonly plaintext: string;
  /** SHA-256 hex digest stored at rest. */
  readonly keyHash: string;
  /** Cleartext display prefix, e.g. "pk_live_a1b2c3d4". */
  readonly keyPrefix: string;
  readonly keyType: KeyType;
}

/** SHA-256 hex of a key. Deterministic, so a presented key can be looked up. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Generate a fresh widget key of the given type. */
export function generateWidgetKey(keyType: KeyType): GeneratedKey {
  const body = randomBytes(KEY_BYTES).toString("hex");
  const plaintext = `${PREFIXES[keyType]}${body}`;
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    keyPrefix: plaintext.slice(0, DISPLAY_PREFIX_LEN),
    keyType,
  };
}

/** Identify a key's type from its prefix (cheap pre-check before a DB lookup). */
export function keyTypeFromValue(key: string): KeyType | null {
  if (key.startsWith(PREFIXES.publishable)) return "publishable";
  if (key.startsWith(PREFIXES.secret)) return "secret";
  return null;
}

/** Constant-time compare of two hex digests (defense against timing probes on
 * any path that compares a hash directly rather than via an indexed lookup). */
export function safeHashEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
