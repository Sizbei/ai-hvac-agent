/**
 * POST /api/webhooks/saas-billing — inbound SaaS-subscription lifecycle webhooks
 * (Stage 10; distinct from the customer-payment Stripe webhook in Stage 11).
 *
 *   1. RATE-LIMITS by source IP (public, unauthenticated endpoint).
 *   2. Reads the RAW body and VERIFIES the HMAC-SHA256 signature in the
 *      `x-saas-billing-signature` header against SAAS_BILLING_WEBHOOK_SECRET.
 *      FAILS CLOSED: no secret configured, missing header, or bad signature →
 *      401. This is the one thing between an attacker and our tenant
 *      plan/status, so it runs before we parse or trust anything.
 *   3. Parses + applies the event IDEMPOTENTLY (dedupe on the provider event id)
 *      onto organizations.plan/status/currentPeriodEnd.
 *
 * Mock-driven until the real Stripe Billing adapter lands: the accepted payload
 * is the test shape { id, type, orgId, planId?, status?, currentPeriodEnd? }.
 * Returns 200 for everything we ACCEPT and process (including intentional no-ops
 * like unknown_org/invalid_plan) so the provider stops retrying; non-2xx is
 * reserved for auth/parse failures we WANT retried (or rejected). The
 * secret/signature are never logged.
 */
import { NextRequest } from "next/server";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";
import {
  SAAS_BILLING_SIGNATURE_HEADER,
  verifyBillingSignature,
} from "@/lib/billing/webhook-signature";
import { parseBillingEvent, applyBillingEvent } from "@/lib/billing/webhook-sync";

export async function POST(request: NextRequest): Promise<Response> {
  const ip = clientIp(request);
  const rate = slidingWindow(
    `webhook:saas-billing:${ip}`,
    RATE_LIMITS.webhook.maxRequests,
    RATE_LIMITS.webhook.windowMs,
  );
  if (!rate.allowed) {
    return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
  }

  try {
    // Read the RAW body once — the exact bytes that were signed.
    const rawBody = await request.text();

    const secret = process.env.SAAS_BILLING_WEBHOOK_SECRET?.trim();
    if (!secret) {
      // Fail closed: with no secret we CANNOT verify authenticity, so we refuse
      // rather than trust the payload. (Configure SAAS_BILLING_WEBHOOK_SECRET.)
      logger.warn("SaaS-billing webhook rejected: no webhook secret configured");
      return errorResponse(
        "Webhook not configured",
        "WEBHOOK_NOT_CONFIGURED",
        401,
      );
    }

    const signature = request.headers.get(SAAS_BILLING_SIGNATURE_HEADER);
    if (!verifyBillingSignature(rawBody, signature, secret)) {
      logger.warn({ ip }, "SaaS-billing webhook rejected: invalid signature");
      return errorResponse("Invalid signature", "INVALID_SIGNATURE", 401);
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return errorResponse("Malformed JSON", "MALFORMED_BODY", 400);
    }

    const event = parseBillingEvent(parsedBody);
    if (!event) {
      return errorResponse("Malformed webhook event", "MALFORMED_EVENT", 400);
    }

    const result = await applyBillingEvent(event);

    // 200 for everything we processed — including intentional no-ops — so the
    // provider stops retrying. The outcome tells operators what happened.
    return successResponse({ outcome: result.outcome });
  } catch (error: unknown) {
    // A 500 lets the provider retry a genuinely transient failure.
    logger.error({ error }, "SaaS-billing webhook processing failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
