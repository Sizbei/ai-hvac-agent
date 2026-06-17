/**
 * GET /api/auth/signup/callback
 *
 * Completes SELF-SERVE signup (isolated from login):
 *   1. Verify the `state` cookie matches the returned state (CSRF).
 *   2. Exchange the auth code for an id_token (signup redirect uri).
 *   3. Verify the id_token (signature via Google's JWKS, iss/aud/exp, nonce).
 *   4. Require email_verified === true.
 *   5. Read + clear the SIGNED business-name intent cookie.
 *   6. provisionOrgWithOwner → branch:
 *        provisioned       → mint admin session (same as login), redirect /admin
 *        existing/google   → /admin/login?notice=existing_account (no provision)
 *        cap_reached       → /signup?error=signups_paused
 *      verify failure / unverified email → /signup?error=verification
 *
 * Degrades to 404 when the signup OIDC env isn't configured. Rate-limited per IP.
 */
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { createAdminSession } from "@/lib/auth/session";
import {
  getGoogleOidcConfig,
  exchangeCodeForIdToken,
  verifyGoogleIdToken,
  type GoogleOidcConfig,
} from "@/lib/auth/google-oidc";
import {
  GOOGLE_OIDC_SIGNUP_STATE_COOKIE,
  GOOGLE_OIDC_SIGNUP_NONCE_COOKIE,
} from "@/lib/auth/google-oidc-state";
import {
  verifySignupIntent,
  SIGNUP_INTENT_COOKIE,
} from "@/lib/auth/signup-intent";
import { provisionOrgWithOwner } from "@/lib/auth/signup";
import { logAudit } from "@/lib/admin/audit";

/** Resolve the SIGNUP OIDC config (base creds + signup redirect override). */
function getSignupOidcConfig(): GoogleOidcConfig | null {
  const base = getGoogleOidcConfig();
  const signupRedirect = process.env.GOOGLE_OIDC_SIGNUP_REDIRECT_URI;
  if (!base || !signupRedirect) {
    return null;
  }
  return { ...base, redirectUri: signupRedirect };
}

/** Constant-time string compare for the CSRF state (avoids a timing oracle). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Clear all three flow cookies on a response (state, nonce, intent). */
function clearFlowCookies(res: NextResponse): NextResponse {
  res.cookies.delete(GOOGLE_OIDC_SIGNUP_STATE_COOKIE);
  res.cookies.delete(GOOGLE_OIDC_SIGNUP_NONCE_COOKIE);
  res.cookies.delete(SIGNUP_INTENT_COOKIE);
  return res;
}

/** Redirect back to /signup with a typed, friendly error. */
function signupError(request: NextRequest, code: string): NextResponse {
  const url = new URL("/signup", request.url);
  url.searchParams.set("error", code);
  return clearFlowCookies(NextResponse.redirect(url));
}

/** Redirect to login with the "you already have an account" notice. */
function existingAccount(request: NextRequest): NextResponse {
  const url = new URL("/admin/login", request.url);
  url.searchParams.set("notice", "existing_account");
  return clearFlowCookies(NextResponse.redirect(url));
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const config = getSignupOidcConfig();
    if (!config) {
      return errorResponse("Not found", "NOT_FOUND", 404);
    }

    const ip = request.headers.get("x-forwarded-for") ?? "unknown";
    const rateCheck = slidingWindow(
      `auth:signup-callback:${ip}`,
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

    if (googleError || !code || !returnedState) {
      return signupError(request, "verification");
    }

    // CSRF: the returned state must match the cookie set in /start.
    const cookieState = request.cookies.get(
      GOOGLE_OIDC_SIGNUP_STATE_COOKIE,
    )?.value;
    const nonce = request.cookies.get(GOOGLE_OIDC_SIGNUP_NONCE_COOKIE)?.value;
    if (!cookieState || !nonce || !safeEqual(cookieState, returnedState)) {
      return signupError(request, "verification");
    }

    // The signed business-name intent must be present + valid.
    const intentCookie = request.cookies.get(SIGNUP_INTENT_COOKIE)?.value;
    const intent = intentCookie
      ? await verifySignupIntent(intentCookie)
      : null;
    if (!intent) {
      return signupError(request, "verification");
    }

    // Exchange + verify the id_token. Any verification failure → generic error.
    let identity;
    try {
      const idToken = await exchangeCodeForIdToken(config, code);
      identity = await verifyGoogleIdToken(idToken, config, nonce);
    } catch (verifyError: unknown) {
      logger.warn({ error: verifyError }, "Signup OIDC verification failed");
      return signupError(request, "verification");
    }

    if (!identity.emailVerified) {
      return signupError(request, "verification");
    }

    const result = await provisionOrgWithOwner({
      businessName: intent.businessName,
      identity,
    });

    switch (result.outcome) {
      case "existing":
      case "google_id_taken":
        // No provisioning happened; send them to login with the notice.
        logger.info(
          { outcome: result.outcome },
          "Self-serve signup redirected to login (existing account)",
        );
        return existingAccount(request);
      case "cap_reached":
        return signupError(request, "signups_paused");
      case "provisioned": {
        await createAdminSession(result.session);
        // Audit the self-serve provision (matches the Stage-9 org_provisioned
        // entry). Details carry ids ONLY — never ownerEmail/businessName (PII).
        // The owner is both the actor and createdBy on this path. Best-effort: an
        // audit-write failure must not abort a successful provision.
        const ipAddress = request.headers.get("x-forwarded-for") ?? "unknown";
        await logAudit({
          organizationId: result.organizationId,
          userId: result.ownerUserId,
          action: "org_provisioned",
          entity: "organization",
          entityId: result.organizationId,
          details: JSON.stringify({ createdBy: result.ownerUserId }),
          ipAddress,
        }).catch((auditError: unknown) => {
          logger.warn(
            { error: auditError, organizationId: result.organizationId },
            "Failed to write org_provisioned audit for self-serve signup",
          );
        });
        logger.info(
          {
            organizationId: result.organizationId,
            userId: result.ownerUserId,
          },
          "Self-serve org provisioned via signup",
        );
        const res = NextResponse.redirect(new URL("/admin", request.url));
        return clearFlowCookies(res);
      }
    }
  } catch (error: unknown) {
    logger.error({ error }, "Self-serve signup callback error");
    return signupError(request, "try_again");
  }
}
