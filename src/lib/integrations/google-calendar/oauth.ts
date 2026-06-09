/**
 * Google OAuth 2.0 plumbing for the Calendar integration.
 *
 * Credentials are read from the environment and NEVER hardcoded:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI.
 *
 * When those are unset the integration DEGRADES SAFELY: {@link getGoogleOAuthConfig}
 * returns null and callers surface a clear "not configured" path instead of
 * attempting a broken flow. Access/refresh tokens are never logged.
 */

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Read+write on the user's calendars — what events.insert/update/delete need. */
export const GOOGLE_CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/**
 * Resolve OAuth credentials from the environment, or null when the integration
 * isn't configured. All three vars must be present; a partial config is treated
 * as not-configured so we never build a half-formed consent URL.
 */
export function getGoogleOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }
  return { clientId, clientSecret, redirectUri };
}

/**
 * Build the Google consent URL. `state` is an opaque CSRF token the callback
 * verifies. `access_type=offline` + `prompt=consent` ensures Google returns a
 * REFRESH token (not just an access token) on first authorization.
 */
export function buildConsentUrl(
  config: GoogleOAuthConfig,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenExchangeResult {
  readonly refreshToken: string;
  readonly accessToken: string;
  /** Epoch ms the access token expires. */
  readonly accessTokenExpiresAt: number;
}

/** Narrow Google's token JSON safely (untrusted external response). */
function parseTokenResponse(raw: unknown): {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
} {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Malformed token response");
  }
  const obj = raw as Record<string, unknown>;
  const accessToken = obj.access_token;
  const expiresIn = obj.expires_in;
  if (typeof accessToken !== "string" || typeof expiresIn !== "number") {
    throw new Error("Token response missing access_token/expires_in");
  }
  const refreshToken =
    typeof obj.refresh_token === "string" ? obj.refresh_token : null;
  return { accessToken, refreshToken, expiresIn };
}

/**
 * Exchange an authorization `code` for tokens (the callback step). Requires the
 * refresh token to be present — Google only returns it with offline+consent, so
 * its absence means the grant won't persist and we should fail loudly.
 *
 * `fetchImpl` is injectable so tests never hit the network.
 */
export async function exchangeCodeForTokens(
  config: GoogleOAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenExchangeResult> {
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
    throw new Error(`Google token exchange failed: HTTP ${res.status}`);
  }
  const parsed = parseTokenResponse(await res.json());
  if (!parsed.refreshToken) {
    throw new Error(
      "Google did not return a refresh token (re-consent with prompt=consent)",
    );
  }
  return {
    refreshToken: parsed.refreshToken,
    accessToken: parsed.accessToken,
    accessTokenExpiresAt: Date.now() + parsed.expiresIn * 1000,
  };
}

export interface AccessTokenResult {
  readonly accessToken: string;
  /** Epoch ms the access token expires. */
  readonly accessTokenExpiresAt: number;
}

/**
 * Mint a fresh access token from a refresh token (the runtime step before any
 * Calendar API call). `fetchImpl` is injectable for tests.
 */
export async function refreshAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessTokenResult> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });
  const res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed: HTTP ${res.status}`);
  }
  const parsed = parseTokenResponse(await res.json());
  return {
    accessToken: parsed.accessToken,
    accessTokenExpiresAt: Date.now() + parsed.expiresIn * 1000,
  };
}
