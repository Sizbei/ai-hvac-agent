/**
 * POST /api/webhooks/housecall — inbound Housecall Pro job-status webhooks.
 * (Stage 5 of the HCP integration: HCP -> us, closing the loop.)
 *
 * HCP POSTs a signed event whenever a job changes status. This endpoint:
 *
 *   1. RATE-LIMITS by source IP (a public, unauthenticated endpoint).
 *   2. Reads the RAW body and VERIFIES the HMAC-SHA256 signature in the
 *      `x-housecallpro-signature` header against the org's webhook secret
 *      (per-org encrypted, or env HOUSECALL_WEBHOOK_SECRET). FAILS CLOSED:
 *      no secret configured, missing header, or bad signature → 401. This is
 *      the one thing standing between an attacker and our state machine, so it
 *      runs before we parse or trust anything.
 *   3. Parses + applies the event idempotently (webhook-sync.applyWebhookEvent):
 *      dedupe on event id, map to our request-status state machine, audit, and
 *      fire a completion follow-up in the background.
 *
 * HCP retries non-2xx, so we return 200 for everything we ACCEPT and process —
 * including events we intentionally ignore (unknown job, unmapped type, illegal
 * transition) — and reserve non-2xx for auth/parse failures we WANT retried (or
 * rejected). The secret/signature are never logged.
 *
 * Single-tenant: like the SMS/voice webhooks, the org resolves to DEMO_ORG_ID
 * (HCP webhooks aren't org-scoped in the URL; a multi-tenant deployment would
 * route by a per-org webhook path or an account id in the payload).
 */
import { NextRequest } from "next/server";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { DEMO_ORG_ID } from "@/lib/tenancy/organization";
import {
  HCP_SIGNATURE_HEADER,
  verifyWebhookSignature,
} from "@/lib/integrations/housecall-pro/webhook-signature";
import { getOrgWebhookSecret } from "@/lib/integrations/housecall-pro/webhook-secret-queries";
import { parseWebhookEvent } from "@/lib/integrations/housecall-pro/webhook-events";
import { applyWebhookEvent } from "@/lib/integrations/housecall-pro/webhook-sync";

export async function POST(request: NextRequest): Promise<Response> {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const rate = slidingWindow(
    `webhook:hcp:${ip}`,
    RATE_LIMITS.chat.maxRequests,
    RATE_LIMITS.chat.windowMs,
  );
  if (!rate.allowed) {
    return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
  }

  const organizationId = DEMO_ORG_ID;

  try {
    // Read the RAW body once — the exact bytes HCP signed. Re-stringifying a
    // parsed object could reorder keys and break the HMAC, so we sign-verify
    // the raw text and parse it ourselves only after the signature checks out.
    const rawBody = await request.text();

    const secret = await getOrgWebhookSecret(organizationId);
    if (!secret) {
      // Fail closed: with no secret we CANNOT verify authenticity, so we refuse
      // rather than trust the payload. (Configure HOUSECALL_WEBHOOK_SECRET or
      // the per-org webhook secret.)
      logger.warn(
        { organizationId },
        "HCP webhook rejected: no webhook secret configured",
      );
      return errorResponse("Webhook not configured", "WEBHOOK_NOT_CONFIGURED", 401);
    }

    const signature = request.headers.get(HCP_SIGNATURE_HEADER);
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
      logger.warn({ organizationId, ip }, "HCP webhook rejected: invalid signature");
      return errorResponse("Invalid signature", "INVALID_SIGNATURE", 401);
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return errorResponse("Malformed JSON", "MALFORMED_BODY", 400);
    }

    const event = parseWebhookEvent(parsedBody);
    if (!event) {
      return errorResponse("Malformed webhook event", "MALFORMED_EVENT", 400);
    }

    const result = await applyWebhookEvent(organizationId, event);

    // 200 for everything we processed — including intentional no-ops — so HCP
    // stops retrying. The outcome tells operators what happened without leaking.
    return successResponse({ outcome: result.outcome });
  } catch (error: unknown) {
    // A 500 lets HCP retry a genuinely transient failure (e.g. a DB blip).
    logger.error({ error, organizationId }, "HCP webhook processing failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
