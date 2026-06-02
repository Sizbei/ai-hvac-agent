import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Domain-separation label so the blind-index HMAC key can never collide with
// the AES encryption key, even though both are derived from ENCRYPTION_KEY.
const BLIND_INDEX_DOMAIN = "hvac-blind-index-v1";

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character hex string (32 bytes)",
    );
  }
  return Buffer.from(key, "hex");
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns base64-encoded string containing: iv (12 bytes) + authTag (16 bytes) + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Format: base64(iv + authTag + ciphertext)
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

/**
 * Decrypts a base64-encoded AES-256-GCM ciphertext back to plaintext.
 * Throws if the ciphertext has been tampered with (authentication failure).
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(ciphertext, "base64");

  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid ciphertext: too short");
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Computes a deterministic, keyed blind index (HMAC-SHA256) of a value.
 *
 * AES-GCM ciphertext is non-deterministic (random IV per encryption), so two
 * rows holding the same email/phone encrypt to different bytes — you can't
 * dedupe or look them up without decrypting every row. A blind index gives a
 * stable, keyed token for the SAME plaintext so we CAN enforce a UNIQUE
 * constraint and do indexed equality lookups, without storing the value in a
 * form that's reversible by a database reader (it's a keyed hash, not
 * encryption). The HMAC key is derived from ENCRYPTION_KEY with a domain
 * label so it never overlaps the AES key.
 *
 * Caller is responsible for normalizing the input first (lowercase email,
 * digits-only phone) so equivalent values hash equally. Returns a 64-char hex
 * digest, or null for empty/whitespace input.
 */
export function blindIndex(normalizedValue: string): string {
  const trimmed = normalizedValue.trim();
  if (trimmed.length === 0) {
    throw new Error("blindIndex requires a non-empty value");
  }
  const key = getEncryptionKey();
  return createHmac("sha256", key)
    .update(BLIND_INDEX_DOMAIN)
    .update("\0")
    .update(trimmed)
    .digest("hex");
}

/**
 * Encrypts specified string fields on an object, returning a new object (immutable).
 * Non-string or empty fields are left unchanged.
 */
export function encryptFields<T extends Record<string, unknown>>(
  data: T,
  fields: readonly (keyof T)[],
): T {
  const result = { ...data };
  for (const field of fields) {
    const value = result[field];
    if (typeof value === "string" && value.length > 0) {
      (result as Record<string, unknown>)[field as string] = encrypt(value);
    }
  }
  return result;
}

/**
 * Decrypts specified string fields on an object, returning a new object (immutable).
 * Non-string or empty fields are left unchanged.
 */
export function decryptFields<T extends Record<string, unknown>>(
  data: T,
  fields: readonly (keyof T)[],
): T {
  const result = { ...data };
  for (const field of fields) {
    const value = result[field];
    if (typeof value === "string" && value.length > 0) {
      (result as Record<string, unknown>)[field as string] = decrypt(value);
    }
  }
  return result;
}
