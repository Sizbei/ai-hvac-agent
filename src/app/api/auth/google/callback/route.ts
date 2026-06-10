/**
 * GET /api/auth/google/callback
 *
 * Completes "Sign in with Google" for the admin suite:
 *   1. Verify the `state` cookie matches the returned state (CSRF).
 *   2. Exchange the auth code for an id_token.
 *   3. Verify the id_token (signature via Google's JWKS, iss/aud/exp, nonce).
 *   4. Require email_verified === true.
 *   5. Resolve to a PRE-PROVISIONED active admin-tier user (no auto-create);
 *      link google_id on first login, reject a sub mismatch.
 *   6. Create the admin session and redirect to /admin.
 *
 * Any failure redirects to /admin/login?error=<code> with a GENERIC message —
 * no account enumeration. Rate-limited per IP. Degrades to 404 when OIDC isn't
 * configured.
 */
import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { createAdminSession } from "@/lib/auth/session";
import {
  getGoogleOidcConfig,
  exchangeCodeForIdToken,
  verifyGoogleIdToken,
} from "@/lib/auth/google-oidc";
import {
  GOOGLE_OIDC_STATE_COOKIE,
  GOOGLE_OIDC_NONCE_COOKIE,
} from "@/lib/auth/google-oidc-state";
import { resolveGoogleLogin } from "@/lib/auth/google-login";

/** Redirect to the login page with a generic error code, clearing flow cookies. */
function denyRedirect(request: NextRequest, code: string): NextResponse {
  const url = new URL("/admin/login", request.url);
  url.searchParams.set("error", code);
  const res = NextResponse.redirect(url);
  res.cookies.delete(GOOGLE_OIDC_STATE_COOKIE);
  res.cookies.delete(GOOGLE_OIDC_NONCE_COOKIE);
  return res;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const config = getGoogleOidcConfig();
    if (!config) {
      return errorResponse("Not found", "NOT_FOUND", 404);
    }

    const ip = request.headers.get("x-forwarded-for") ?? "unknown";
    const rateCheck = slidingWindow(
      `auth:google-callback:${ip}`,
      RATE_LIMITS.sessionCreate.maxRequests,
      RATE_LIMITS.sessionCreate.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const params = request.nextUrl.searchParams;
    const code = params.get("code");
    const returnedState = params.get("state");
    const googleError = params.get("error");

    // The user denied consent, or Google returned an error.
    if (googleError || !code || !returnedState) {
      return denyRedirect(request, "google_failed");
    }

    // CSRF: the returned state must match the cookie we set in /start.
    const cookieState = request.cookies.get(GOOGLE_OIDC_STATE_COOKIE)?.value;
    const nonce = request.cookies.get(GOOGLE_OIDC_NONCE_COOKIE)?.value;
    if (!cookieState || !nonce || cookieState !== returnedState) {
      return denyRedirect(request, "google_failed");
    }

    // Exchange + verify the id_token. Any verification failure → generic denial.
    let identity;
    try {
      const idToken = await exchangeCodeForIdToken(config, code);
      identity = await verifyGoogleIdToken(idToken, config, nonce);
    } catch (verifyError: unknown) {
      logger.warn({ error: verifyError }, "Google OIDC verification failed");
      return denyRedirect(request, "google_failed");
    }

    if (!identity.emailVerified) {
      return denyRedirect(request, "email_unverified");
    }

    const result = await resolveGoogleLogin(identity);
    if (!result.ok) {
      // Both "no_account" and "sub_mismatch" surface the same generic message.
      logger.warn(
        { reason: result.reason },
        "Google OIDC login denied",
      );
      return denyRedirect(request, "no_account");
    }

    await createAdminSession(result.session);
    logger.info(
      { userId: result.session.userId },
      "Admin login via Google successful",
    );

    // Success: land in the dashboard and clear the one-shot flow cookies.
    const res = NextResponse.redirect(new URL("/admin", request.url));
    res.cookies.delete(GOOGLE_OIDC_STATE_COOKIE);
    res.cookies.delete(GOOGLE_OIDC_NONCE_COOKIE);
    return res;
  } catch (error: unknown) {
    logger.error({ error }, "Google OIDC callback error");
    return denyRedirect(request, "google_failed");
  }
}
