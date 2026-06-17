/**
 * Cookie names + lifetime for the Google OIDC login round-trip.
 *
 * The /start route mints a `state` (CSRF) and a `nonce` (id_token replay
 * binding), stores both in short-lived httpOnly cookies, and embeds them in the
 * consent URL. The /callback compares the returned `state` to the cookie and the
 * id_token's `nonce` claim to the cookie — a mismatch or missing cookie means
 * the response wasn't initiated by us, so the callback rejects it.
 */
import "server-only";

export const GOOGLE_OIDC_STATE_COOKIE = "hvac_oidc_state";
export const GOOGLE_OIDC_NONCE_COOKIE = "hvac_oidc_nonce";
/** Short-lived: the consent round-trip is seconds, not hours. */
export const GOOGLE_OIDC_FLOW_MAX_AGE = 10 * 60; // 10 minutes

/**
 * DISTINCT cookie names for the self-serve SIGNUP OIDC round-trip. The signup
 * flow mirrors login's state/nonce dance but MUST use its own cookies: a user
 * who has login open in one tab and signup in another would otherwise have the
 * two flows clobber each other's state/nonce, breaking both. The signup
 * /start + /callback routes use ONLY these; the login flow's cookies above are
 * untouched. Same lifetime (GOOGLE_OIDC_FLOW_MAX_AGE).
 */
export const GOOGLE_OIDC_SIGNUP_STATE_COOKIE = "hvac_signup_oidc_state";
export const GOOGLE_OIDC_SIGNUP_NONCE_COOKIE = "hvac_signup_oidc_nonce";
