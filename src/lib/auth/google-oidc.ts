import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Google OpenID Connect (OIDC) plumbing for "Sign in with Google" on the admin
 * suite. This is SEPARATE from the Calendar OAuth flow (different scopes +
 * redirect URI), but reuses the same client credentials.
 *
 * Credentials are read from the environment and NEVER hardcoded:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OIDC_REDIRECT_URI
 *
 * When unset the feature DEGRADES SAFELY: {@link getGoogleOidcConfig} returns
 * null, the /start route 404s, and the login page hides the button — password
 * login is unaffected. No tokens are ever logged.
 *
 * SECURITY: the id_token returned by Google is a signed JWT. We verify its
 * signature against Google's published JWKS and validate iss/aud/exp/nonce
 * before trusting ANY claim (email, sub). We never trust the userinfo endpoint
 * or unsigned data.
 */

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
/** Both forms Google uses for the `iss` claim. */
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** OIDC scopes: identity only. We do not request any Google API access here. */
export const GOOGLE_OIDC_SCOPE = "openid email profile";

export interface GoogleOidcConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/**
 * Resolve OIDC credentials from the environment, or null when login-with-Google
 * isn't configured. All three must be present; a partial config is treated as
 * not-configured so we never build a half-formed consent URL.
 */
export function getGoogleOidcConfig(): GoogleOidcConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OIDC_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }
  return { clientId, clientSecret, redirectUri };
}

/**
 * Build the Google consent URL for OIDC login. `state` is an opaque CSRF token
 * the callback verifies; `nonce` binds the resulting id_token to this request
 * (replay protection). We do NOT request offline access — login needs no refresh
 * token, only a one-shot identity assertion.
 */
export function buildOidcConsentUrl(
  config: GoogleOidcConfig,
  state: string,
  nonce: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_OIDC_SCOPE,
    state,
    nonce,
    // Force the account chooser so a shared browser doesn't silently reuse a
    // previously-consented Google account.
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Exchange an authorization `code` for Google's token response and return the
 * raw id_token (a signed JWT). Throws on a non-OK response or a missing
 * id_token. `fetchImpl` is injectable for tests.
 */
export async function exchangeCodeForIdToken(
  config: GoogleOidcConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Google OIDC token exchange failed: HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  if (
    typeof json !== "object" ||
    json === null ||
    typeof (json as { id_token?: unknown }).id_token !== "string"
  ) {
    throw new Error("Google OIDC token response missing id_token");
  }
  return (json as { id_token: string }).id_token;
}

export interface VerifiedGoogleIdentity {
  /** Google's stable unique subject id for this account. */
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string | null;
}

// One JWKS fetcher per process; jose caches and rotates keys internally. Created
// lazily so importing this module never makes a network call.
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI));
  }
  return jwksCache;
}

/**
 * Verify a Google id_token's signature (against Google's JWKS) and its claims:
 * issuer, audience (our client id), expiry (handled by jwtVerify), and the nonce
 * we minted for this request. Returns the trusted identity, or throws on any
 * verification failure.
 *
 * `jwksOverride` lets tests inject a local key set so verification runs without
 * network access.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  config: GoogleOidcConfig,
  expectedNonce: string,
  jwksOverride?: Parameters<typeof jwtVerify>[1],
): Promise<VerifiedGoogleIdentity> {
  const keySet = jwksOverride ?? getJwks();
  const { payload } = await jwtVerify(idToken, keySet, {
    issuer: GOOGLE_ISSUERS,
    audience: config.clientId,
  });

  // Replay protection: the id_token must carry the exact nonce we sent.
  if (payload.nonce !== expectedNonce) {
    throw new Error("Google OIDC nonce mismatch");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const email =
    typeof payload.email === "string" ? payload.email : null;
  // Google sends email_verified as a boolean (or occasionally the string
  // "true"); accept both, treat anything else as unverified.
  const emailVerifiedClaim = payload.email_verified;
  const emailVerified =
    emailVerifiedClaim === true || emailVerifiedClaim === "true";
  const name = typeof payload.name === "string" ? payload.name : null;

  if (!sub || !email) {
    throw new Error("Google OIDC id_token missing sub or email");
  }

  return { sub, email, emailVerified, name };
}
