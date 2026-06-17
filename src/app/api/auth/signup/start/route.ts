/**
 * POST /api/auth/signup/start
 *
 * Begins SELF-SERVE signup (parallel to, and isolated from, login): validates
 * the business name, mints a CSRF `state` + a `nonce`, sets those plus a SIGNED,
 * short-lived `hvac_signup_intent` cookie carrying the business name, and
 * redirects to Google's consent screen built with the SIGNUP-specific redirect
 * uri. The login flow (resolveGoogleLogin, google/start) is untouched.
 *
 * DEGRADES SAFELY: 404 when GOOGLE_OIDC_SIGNUP_REDIRECT_URI (or the base OIDC
 * env) is unset — the signup page hides the button and the route does not exist.
 * Rate-limited per IP (RATE_LIMITS.sessionCreate, matching login).
 */
import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  getGoogleOidcConfig,
  buildOidcConsentUrl,
  type GoogleOidcConfig,
} from "@/lib/auth/google-oidc";
import {
  GOOGLE_OIDC_SIGNUP_STATE_COOKIE,
  GOOGLE_OIDC_SIGNUP_NONCE_COOKIE,
  GOOGLE_OIDC_FLOW_MAX_AGE,
} from "@/lib/auth/google-oidc-state";
import {
  signSignupIntent,
  SIGNUP_INTENT_COOKIE,
  SIGNUP_INTENT_MAX_AGE,
} from "@/lib/auth/signup-intent";

const MAX_BUSINESS_NAME_LENGTH = 100;

/**
 * Resolve the SIGNUP OIDC config: the base credentials with the redirect uri
 * overridden by GOOGLE_OIDC_SIGNUP_REDIRECT_URI. Returns null (→ 404) when the
 * base OIDC env or the signup redirect uri is unset. We never mutate the shared
 * login config — we pass a fresh object so the login redirect uri is unaffected.
 */
function getSignupOidcConfig(): GoogleOidcConfig | null {
  const base = getGoogleOidcConfig();
  const signupRedirect = process.env.GOOGLE_OIDC_SIGNUP_REDIRECT_URI;
  if (!base || !signupRedirect) {
    return null;
  }
  return { ...base, redirectUri: signupRedirect };
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const config = getSignupOidcConfig();
    if (!config) {
      return errorResponse("Not found", "NOT_FOUND", 404);
    }

    const ip = request.headers.get("x-forwarded-for") ?? "unknown";
    const rateCheck = slidingWindow(
      `auth:signup-start:${ip}`,
      RATE_LIMITS.sessionCreate.maxRequests,
      RATE_LIMITS.sessionCreate.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    // The page posts a form; accept form-encoded or JSON.
    let businessName = "";
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body: unknown = await request.json().catch(() => null);
      businessName =
        typeof (body as { businessName?: unknown })?.businessName === "string"
          ? (body as { businessName: string }).businessName
          : "";
    } else {
      const form = await request.formData();
      const raw = form.get("businessName");
      businessName = typeof raw === "string" ? raw : "";
    }

    businessName = businessName.trim();
    if (
      businessName.length === 0 ||
      businessName.length > MAX_BUSINESS_NAME_LENGTH
    ) {
      // Friendly, typed error the page renders.
      return NextResponse.redirect(
        new URL("/signup?error=invalid_name", request.url),
        303,
      );
    }

    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const intentToken = await signSignupIntent({ businessName });
    const consentUrl = buildOidcConsentUrl(config, state, nonce);

    // 303 so a POST cannot redirect into a re-POST at Google.
    const response = NextResponse.redirect(consentUrl, 303);
    const flowCookieOpts = {
      httpOnly: true,
      // Secure everywhere except local dev (http); staging/preview run HTTPS.
      secure: process.env.NODE_ENV !== "development",
      // The callback returns from Google (a cross-site GET), so "lax" is required
      // for these cookies to be sent on the redirect back.
      sameSite: "lax" as const,
      path: "/",
    };
    response.cookies.set(GOOGLE_OIDC_SIGNUP_STATE_COOKIE, state, {
      ...flowCookieOpts,
      maxAge: GOOGLE_OIDC_FLOW_MAX_AGE,
    });
    response.cookies.set(GOOGLE_OIDC_SIGNUP_NONCE_COOKIE, nonce, {
      ...flowCookieOpts,
      maxAge: GOOGLE_OIDC_FLOW_MAX_AGE,
    });
    response.cookies.set(SIGNUP_INTENT_COOKIE, intentToken, {
      ...flowCookieOpts,
      maxAge: SIGNUP_INTENT_MAX_AGE,
    });
    return response;
  } catch (error: unknown) {
    logger.error({ error }, "Failed to start self-serve signup");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
