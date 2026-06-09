/**
 * CSRF `state` for the Google OAuth round-trip.
 *
 * The connect route mints a random state, stashes it in an httpOnly cookie, and
 * puts it in the consent URL. The callback compares the returned `state` to the
 * cookie — a mismatch (or missing cookie) means the response wasn't initiated by
 * us, so the callback rejects it. Standard OAuth CSRF defense.
 */
import "server-only";
import { randomBytes } from "node:crypto";

export const GOOGLE_OAUTH_STATE_COOKIE = "hvac_gcal_oauth_state";
/** Short-lived: the consent round-trip is seconds, not hours. */
export const GOOGLE_OAUTH_STATE_MAX_AGE = 10 * 60; // 10 minutes

/** A fresh, URL-safe random state token. */
export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}
