/**
 * POST /api/admin/integrations/housecall/connect
 *
 * Connect an org's Housecall Pro account: accepts an API key, VALIDATES it with
 * a live probe (getAccountInfo) before persisting, then stores it ENCRYPTED and
 * caches the non-secret account metadata.
 *
 * Admin-session-gated + rate-limited + audited. The submitted key is validated
 * against the live HCP API (the ONE place a real call is made); on success it
 * is encrypted at rest. The key is NEVER logged and NEVER returned. An invalid
 * key yields a clear 400 rather than a stored-but-broken connection.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { RestHousecallProClient } from "@/lib/integrations/housecall-pro/client";
import { saveHousecallConnection } from "@/lib/integrations/housecall-pro/connection-queries";

const HOUSECALL_API_BASE = "https://api.housecallpro.com";

/**
 * The connect body: the API key, plus an OPTIONAL webhook signing secret
 * (Stage 5). HCP's public API does not expose a webhook-management endpoint, so
 * webhooks are configured MANUALLY in the HCP dashboard (Settings → API &
 * Webhooks): point the webhook at POST /api/webhooks/housecall and paste the
 * signing secret HCP shows here so inbound job-status events can be verified.
 * Omitted → any previously stored secret is preserved; the env-level
 * HOUSECALL_WEBHOOK_SECRET is the single-tenant fallback.
 */
const connectSchema = z.object({
  apiKey: z.string().trim().min(1, "API key is required"),
  webhookSecret: z.string().trim().min(1).optional(),
});

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:hcp-connect:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = connectSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        parsed.error.issues[0]?.message ?? "Invalid request",
        "VALIDATION_ERROR",
        400,
      );
    }

    // Validate the key with a live probe BEFORE persisting. A built-from-input
    // client (not the factory) — the key isn't stored yet.
    const client = new RestHousecallProClient({
      apiKey: parsed.data.apiKey,
      baseUrl: HOUSECALL_API_BASE,
    });

    let accountInfo;
    try {
      accountInfo = await client.getAccountInfo();
    } catch {
      // Don't log the error body — it could echo the key. Surface a clean 400.
      return errorResponse(
        "Could not validate the Housecall Pro API key. Check the key and that the account is on the MAX plan.",
        "HOUSECALL_KEY_INVALID",
        400,
      );
    }

    await saveHousecallConnection(session.organizationId, {
      apiKey: parsed.data.apiKey,
      accountInfo,
      webhookSecret: parsed.data.webhookSecret,
    });

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "housecall_pro_connected",
      entity: "housecall_pro_connection",
      entityId: session.organizationId,
      // Non-secret only: confirm an account was linked, never the key.
      details: JSON.stringify({ accountId: accountInfo.accountId }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit Housecall connect");
    });

    return successResponse({ connected: true, accountInfo });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to connect Housecall Pro");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
