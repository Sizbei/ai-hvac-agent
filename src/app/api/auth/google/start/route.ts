/**
 * GET /api/auth/google/start
 *
 * Begins "Sign in with Google" for the admin suite: mints a CSRF `state` and a
 * `nonce`, stores both in short-lived httpOnly cookies, and redirects to
 * Google's consent screen. This route is PRE-authentication by design — there is
 * no admin session yet; the callback establishes one only for a pre-provisioned
 * admin-tier user.
 *
 * DEGRADES SAFELY: if OIDC env isn't configured, returns 404 (the feature does
 * not exist) so the login page's button can be hidden and password login is
 * unaffected. Rate-limited per IP to blunt redirect/abuse.
 */
import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";
import {
  getGoogleOidcConfig,
  buildOidcConsentUrl,
} from "@/lib/auth/google-oidc";
import {
  GOOGLE_OIDC_STATE_COOKIE,
  GOOGLE_OIDC_NONCE_COOKIE,
  GOOGLE_OIDC_FLOW_MAX_AGE,
} from "@/lib/auth/google-oidc-state";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const config = getGoogleOidcConfig();
    if (!config) {
      // Feature not configured → behave as if the route doesn't exist.
      return errorResponse("Not found", "NOT_FOUND", 404);
    }

    const ip = clientIp(request);
    const rateCheck = slidingWindow(
      `auth:google-start:${ip}`,
      RATE_LIMITS.sessionCreate.maxRequests,
      RATE_LIMITS.sessionCreate.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const consentUrl = buildOidcConsentUrl(config, state, nonce);

    const response = NextResponse.redirect(consentUrl);
    const cookieOpts = {
      httpOnly: true,
      // Secure everywhere except local dev (http) — staging/preview run over
      // HTTPS and must not leak these OIDC guards over a non-Secure cookie.
      secure: process.env.NODE_ENV !== "development",
      // The callback returns from Google (a cross-site GET), so "lax" is required
      // for these cookies to be sent on the redirect back.
      sameSite: "lax" as const,
      maxAge: GOOGLE_OIDC_FLOW_MAX_AGE,
      path: "/",
    };
    response.cookies.set(GOOGLE_OIDC_STATE_COOKIE, state, cookieOpts);
    response.cookies.set(GOOGLE_OIDC_NONCE_COOKIE, nonce, cookieOpts);
    return response;
  } catch (error: unknown) {
    logger.error({ error }, "Failed to start Google OIDC login");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
