import "server-only";

import { SignJWT, jwtVerify } from "jose";

/**
 * The signed, short-lived cookie that carries the self-serve signup's
 * `businessName` across the Google OAuth round-trip.
 *
 * The businessName is user input that must survive a redirect to Google and
 * back. We never trust it raw in a cookie: it is signed as a JWT with the same
 * AUTH_SECRET + algorithm the admin session uses (the existing signing
 * mechanism), so a tampered or forged cookie fails verification and the callback
 * rejects the signup. This is DISTINCT from the OIDC state/nonce cookies (which
 * provide CSRF + id_token replay protection) and from the admin session cookie.
 */

export const SIGNUP_INTENT_COOKIE = "hvac_signup_intent";
/** Short-lived: the consent round-trip is seconds, not hours. Matches the OIDC
 * flow cookie lifetime. */
export const SIGNUP_INTENT_MAX_AGE = 10 * 60; // 10 minutes (seconds)

const ALGORITHM = "HS256";
/** JWT exp, in the format jose accepts. Mirrors SIGNUP_INTENT_MAX_AGE. */
const EXPIRATION = "10m";
const MIN_SECRET_LENGTH = 32;

function getEncodedKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SECRET environment variable must be set and at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  return new TextEncoder().encode(secret);
}

export interface SignupIntent {
  readonly businessName: string;
}

/** Sign a signup intent into a JWT for the short-lived intent cookie. */
export async function signSignupIntent(intent: SignupIntent): Promise<string> {
  const encodedKey = getEncodedKey();
  return new SignJWT({ businessName: intent.businessName })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(EXPIRATION)
    .sign(encodedKey);
}

/** Verify + decode a signup intent cookie. Returns null on any failure
 * (tampered, expired, missing/blank businessName) — the callback treats a null
 * as "no valid intent" and rejects the signup. */
export async function verifySignupIntent(
  token: string,
): Promise<SignupIntent | null> {
  try {
    const encodedKey = getEncodedKey();
    const { payload } = await jwtVerify(token, encodedKey, {
      algorithms: [ALGORITHM],
    });
    if (
      typeof payload.businessName !== "string" ||
      payload.businessName.trim().length === 0
    ) {
      return null;
    }
    return { businessName: payload.businessName };
  } catch {
    return null;
  }
}
