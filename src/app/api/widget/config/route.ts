import { NextRequest, NextResponse } from "next/server";
import { validateKey } from "@/lib/widget/key-queries";
import { getOrgConfig } from "@/lib/admin/org-config-queries";
import { corsHeaders } from "@/lib/widget/cors";
import { isOriginAllowed } from "@/lib/widget/origin";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

/**
 * Public, CORS-enabled config endpoint for the embed loader. Given a publishable
 * key (?key=pk_live_…), returns the PUBLIC branding the bubble needs — no
 * secrets, no PII, no admin data. The loader caches this client-side.
 */

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  // Preflight: we don't yet know the org (key is a query param, not sent on
  // preflight), so reflect the origin permissively here; the actual GET still
  // enforces the per-org allowlist before returning any data.
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(origin, []),
  });
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");
  const ip = clientIp(request);

  const rate = slidingWindow(
    `widget:config:${ip}`,
    RATE_LIMITS.sessionCreate.maxRequests,
    RATE_LIMITS.sessionCreate.windowMs,
  );
  if (!rate.allowed) {
    return NextResponse.json(
      { success: false, error: { message: "Rate limited", code: "RATE_LIMITED" } },
      { status: 429, headers: corsHeaders(origin, []) },
    );
  }

  const key = request.nextUrl.searchParams.get("key");
  const validated = key ? await validateKey(key) : null;
  if (!validated || validated.keyType !== "publishable") {
    return NextResponse.json(
      { success: false, error: { message: "Invalid key", code: "INVALID_KEY" } },
      { status: 403, headers: corsHeaders(origin, []) },
    );
  }

  const config = await getOrgConfig(validated.organizationId);

  // Enforce the org allowlist on the cross-origin read too.
  if (
    config.allowedOrigins.length > 0 &&
    !isOriginAllowed(origin, config.allowedOrigins)
  ) {
    logger.warn(
      { organizationId: validated.organizationId, origin },
      "Widget config requested from a non-allowlisted origin",
    );
    return NextResponse.json(
      {
        success: false,
        error: { message: "Origin not allowed", code: "ORIGIN_NOT_ALLOWED" },
      },
      { status: 403, headers: corsHeaders(origin, config.allowedOrigins) },
    );
  }

  // Only PUBLIC branding fields — never business info, services, or FAQs.
  const publicConfig = {
    companyName: config.companyName,
    logoUrl: config.logoUrl,
    primaryColor: config.primaryColor,
    welcomeMessage: config.welcomeMessage,
    launcherPosition: config.launcherPosition,
  };

  return NextResponse.json(
    { success: true, data: { config: publicConfig } },
    {
      status: 200,
      headers: {
        ...corsHeaders(origin, config.allowedOrigins),
        // `private` so a shared CDN can't serve one org's branding (or one
        // origin's reflected CORS header) to another. The widget loader caches
        // client-side in localStorage anyway.
        "Cache-Control": "private, max-age=300",
      },
    },
  );
}
