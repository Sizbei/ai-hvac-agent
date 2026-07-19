import { NextResponse, type NextRequest } from "next/server";
import { verifyToken } from "@/lib/auth/config";
import { allowedOriginsForKey } from "@/lib/widget/key-queries";
import { originsToFrameAncestors } from "@/lib/widget/origin";

const ADMIN_SESSION_COOKIE = "hvac_admin_session";

function addSecurityHeaders(response: NextResponse, requestId: string): void {
  response.headers.set("X-Request-Id", requestId);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // HSTS: pin HTTPS for 2 years (incl. subdomains). Only meaningful over HTTPS
  // (Vercel serves all traffic over HTTPS); harmless on local http.
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains",
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- Embeddable chat panel ---
  // /embed is meant to be framed by contractors' sites, so it must NOT get the
  // blanket X-Frame-Options: DENY. But it collects PII, so we scope WHO can
  // frame it: frame-ancestors is restricted to the org's configured allowlist
  // (resolved from the ?key= publishable key). Only when the org has NOT
  // configured any allowlist do we fall back to `*` (consistent with the rest
  // of the system: empty allowlist = open). This blocks clickjacking by sites
  // the org hasn't authorized, even using the org's public key.
  if (pathname === "/embed" || pathname.startsWith("/embed/")) {
    const response = NextResponse.next();
    const requestId =
      request.headers.get("x-request-id") ?? crypto.randomUUID();
    response.headers.set("X-Request-Id", requestId);
    response.headers.set("X-Content-Type-Options", "nosniff");

    const key = request.nextUrl.searchParams.get("key");
    let frameAncestors = "frame-ancestors 'self'";
    if (key) {
      const allowed = await allowedOriginsForKey(key).catch(() => null);
      if (allowed === null) {
        // Unknown/invalid key — don't allow framing anywhere meaningful.
        frameAncestors = "frame-ancestors 'self'";
      } else if (allowed.length === 0) {
        frameAncestors = "frame-ancestors *"; // org hasn't locked down domains
      } else {
        frameAncestors = `frame-ancestors 'self' ${originsToFrameAncestors(allowed)}`;
      }
    }
    response.headers.set("Content-Security-Policy", frameAncestors);
    return response;
  }

  // --- Admin page route protection ---
  if (pathname.startsWith("/admin")) {
    // Redirect /admin exactly to /admin/requests
    if (pathname === "/admin") {
      return NextResponse.redirect(new URL("/admin/requests", request.url));
    }

    // Allow /admin/login, the password-recovery page, and the public
    // invite-accept page without auth. All three are pre-authentication by
    // design: forgot-password is a recovery guide with no session, and the
    // invite page opens a tokenized link to set a password before any
    // account/session exists. The invite page is fully token-gated server-side
    // (resolveInviteByToken); the token is the bearer of authority, not a session.
    if (
      pathname === "/admin/login" ||
      pathname === "/admin/forgot-password" ||
      pathname.startsWith("/admin/invite/")
    ) {
      const response = NextResponse.next();
      const requestId =
        request.headers.get("x-request-id") ?? crypto.randomUUID();
      addSecurityHeaders(response, requestId);
      // The public invite-accept page takes a password from an UNauthenticated
      // user, so give it a defense-in-depth CSP. 'unsafe-inline' is required for
      // Next's hydration/styles; we still pin script/connect to 'self' so no
      // third-party origin can run script or exfiltrate the form. (Scoped to the
      // invite page only — the authenticated dashboard isn't constrained here.)
      if (pathname.startsWith("/admin/invite/")) {
        response.headers.set(
          "Content-Security-Policy",
          [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "connect-src 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
          ].join("; "),
        );
      }
      return response;
    }

    // All other /admin/* pages require authentication
    const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
    const session = token ? await verifyToken(token) : null;

    if (!session) {
      return NextResponse.redirect(new URL("/admin/login", request.url));
    }
  }

  // --- Admin API route protection ---
  if (pathname.startsWith("/api/admin")) {
    // Inbound webhooks live under /api/admin/integrations/* for historical
    // reasons but are SERVER-TO-SERVER: they authenticate via HMAC signature
    // (see their route handlers), not an admin session. Excluding them from the
    // session gate is required — otherwise this middleware would 401 every
    // Fieldpulse webhook delivery.
    const isPublicWebhook =
      pathname === "/api/admin/integrations/fieldpulse/webhook" ||
      pathname === "/api/admin/integrations/fieldpulse/invoice-webhook";

    if (!isPublicWebhook) {
      const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
      const session = token ? await verifyToken(token) : null;

      if (!session) {
        return NextResponse.json(
          {
            success: false,
            error: { message: "Unauthorized", code: "UNAUTHORIZED" },
          },
          { status: 401 },
        );
      }
    }
  }

  // --- Default: apply security headers and pass through ---
  const response = NextResponse.next();
  const requestId =
    request.headers.get("x-request-id") ?? crypto.randomUUID();
  addSecurityHeaders(response, requestId);

  return response;
}

export const config = {
  matcher: ["/api/:path*", "/admin/:path*", "/embed/:path*", "/embed"],
};
