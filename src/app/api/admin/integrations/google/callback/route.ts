/**
 * GET /api/admin/integrations/google/callback?code=...&state=...
 *
 * The OAuth redirect target. Verifies the CSRF `state` against the cookie set by
 * connect, exchanges the authorization `code` for a refresh token, stores it
 * ENCRYPTED, then redirects back to the settings page.
 *
 * DEGRADES SAFELY when not configured. Admin-session-gated + audited. Tokens are
 * never logged.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { logAudit } from "@/lib/admin/audit";
import { errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  getGoogleOAuthConfig,
  exchangeCodeForTokens,
} from "@/lib/integrations/google-calendar/oauth";
import { GOOGLE_OAUTH_STATE_COOKIE } from "@/lib/integrations/google-calendar/oauth-state";
import { saveGoogleConnection } from "@/lib/integrations/google-calendar/connection-queries";

const SETTINGS_PATH = "/admin/settings";

/** Redirect back to settings with a status flag the panel can surface. */
function settingsRedirect(request: NextRequest, status: string): NextResponse {
  const url = new URL(SETTINGS_PATH, request.nextUrl.origin);
  url.searchParams.set("gcal", status);
  const response = NextResponse.redirect(url);
  // The single-use state cookie has done its job; clear it.
  response.cookies.delete(GOOGLE_OAUTH_STATE_COOKIE);
  return response;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:gcal-callback:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const config = getGoogleOAuthConfig();
    if (!config) {
      return errorResponse(
        "Google Calendar is not configured.",
        "GOOGLE_NOT_CONFIGURED",
        503,
      );
    }

    // Google reports user-side failures (e.g. "access_denied") via ?error.
    const oauthError = request.nextUrl.searchParams.get("error");
    if (oauthError) {
      logger.warn({ oauthError }, "Google OAuth consent declined");
      return settingsRedirect(request, "denied");
    }

    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const cookieState = request.cookies.get(GOOGLE_OAUTH_STATE_COOKIE)?.value;

    if (!code || !state) {
      return errorResponse("Missing code or state", "INVALID_CALLBACK", 400);
    }
    // CSRF guard: the state must match the one we set on connect.
    if (!cookieState || cookieState !== state) {
      logger.warn("Google OAuth state mismatch — rejecting callback");
      return errorResponse("Invalid OAuth state", "INVALID_STATE", 400);
    }

    const tokens = await exchangeCodeForTokens(config, code);
    await saveGoogleConnection(session.organizationId, {
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      calendarId: "primary",
    });

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "google_calendar_connected",
      entity: "google_calendar_connection",
      // No token material — just the calendar target.
      details: JSON.stringify({ calendarId: "primary" }),
    });

    return settingsRedirect(request, "connected");
  } catch (error: unknown) {
    logger.error({ error }, "Failed to complete Google Calendar callback");
    // Don't leak the underlying error; send the admin back with a failure flag.
    return errorResponse(
      "Failed to connect Google Calendar",
      "GOOGLE_CONNECT_FAILED",
      502,
    );
  }
}
