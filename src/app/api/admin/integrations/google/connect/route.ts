/**
 * GET /api/admin/integrations/google/connect
 *
 * Starts the per-org Google Calendar OAuth flow: mints a CSRF `state`, stores it
 * in an httpOnly cookie, and redirects the admin to Google's consent screen.
 *
 * DEGRADES SAFELY: if GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI aren't set, returns a
 * clear 503 "not configured" instead of a broken redirect. Admin-session-gated
 * + rate-limited + audited.
 */
import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { logAudit } from "@/lib/admin/audit";
import { errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  getGoogleOAuthConfig,
  buildConsentUrl,
} from "@/lib/integrations/google-calendar/oauth";
import {
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_OAUTH_STATE_MAX_AGE,
  createOAuthState,
} from "@/lib/integrations/google-calendar/oauth-state";

export async function GET(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:gcal-connect:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const config = getGoogleOAuthConfig();
    if (!config) {
      // Safe degrade: the human hasn't supplied OAuth credentials yet.
      return errorResponse(
        "Google Calendar is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
        "GOOGLE_NOT_CONFIGURED",
        503,
      );
    }

    const state = createOAuthState();
    const consentUrl = buildConsentUrl(config, state);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "google_calendar_connect_started",
      entity: "google_calendar_connection",
      // Non-PII, no token material — just the intent.
      details: JSON.stringify({ initiated: true }),
    });

    const response = NextResponse.redirect(consentUrl);
    response.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      // The callback returns from Google (a cross-site GET), so "lax" — not
      // "strict" — is required for the state cookie to be sent on the redirect.
      sameSite: "lax",
      maxAge: GOOGLE_OAUTH_STATE_MAX_AGE,
      path: "/",
    });
    return response;
  } catch (error: unknown) {
    logger.error({ error }, "Failed to start Google Calendar connect");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
