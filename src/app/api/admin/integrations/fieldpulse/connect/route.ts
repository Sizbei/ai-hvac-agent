/**
 * POST /api/admin/integrations/fieldpulse/connect
 *
 * Connect an org's Fieldpulse account: accepts an API key, VALIDATES it with
 * a live probe (getAccountInfo) before persisting, then stores it ENCRYPTED and
 * caches the non-secret account metadata.
 *
 * Admin-session-gated + rate-limited + audited. The submitted key is validated
 * against the live Fieldpulse API; on success it is encrypted at rest. The key
 * is NEVER logged and NEVER returned. An invalid key yields a clear 400.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { RestFieldpulseClient } from "@/lib/integrations/fieldpulse/client";
import { saveFieldpulseConnection } from "@/lib/integrations/fieldpulse/connection-queries";
import { FIELDPULSE_BASE_URL } from "@/lib/integrations/fieldpulse/config";

/**
 * The connect body: the API key, plus an OPTIONAL webhook signing secret.
 * Fieldpulse's public API may not expose webhook management; webhooks may be
 * configured manually in the Fieldpulse dashboard. Omitted → any previously
 * stored secret is preserved.
 */
const connectSchema = z.object({
  apiKey: z.string().trim().min(1, "API key is required"),
  // The signing secret is HMAC-keyed as hex (see webhook-signature.ts). Enforce
  // even-length hex here so a non-hex secret can't be stored and later decode to
  // an empty key (a publicly-forgeable HMAC). Empty string is allowed and means
  // "no secret"; omitted preserves any previously stored secret.
  webhookSecret: z
    .string()
    .trim()
    .regex(/^([0-9a-fA-F]{2})*$/, "Webhook secret must be an even-length hex string")
    .optional(),
});

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:fieldpulse-connect:${session.userId}`,
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

    // Validate the key with a live probe BEFORE persisting.
    const client = new RestFieldpulseClient(
      {
        apiKey: parsed.data.apiKey,
        baseUrl: FIELDPULSE_BASE_URL,
      },
      fetch,
    );

    let accountInfo;
    try {
      accountInfo = await client.getAccountInfo();
    } catch {
      // Don't log the error body — it could echo the key. Surface a clean 400.
      return errorResponse(
        "Could not validate the Fieldpulse API key. Check the key and try again.",
        "FIELDPULSE_KEY_INVALID",
        400,
      );
    }

    await saveFieldpulseConnection(session.organizationId, {
      apiKey: parsed.data.apiKey,
      accountInfo,
      webhookSecret: parsed.data.webhookSecret,
    });

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "fieldpulse_connected",
      entity: "fieldpulse_connection",
      entityId: session.organizationId,
      // Non-secret only: confirm an account was linked, never the key.
      details: JSON.stringify({ accountId: accountInfo.accountId }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit Fieldpulse connect");
    });

    return successResponse({ connected: true, accountInfo });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to connect Fieldpulse");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
