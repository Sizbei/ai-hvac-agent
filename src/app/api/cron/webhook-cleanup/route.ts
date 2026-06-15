/**
 * Vercel Cron Job: Webhook Event Cleanup
 *
 * This endpoint is called by Vercel Cron daily to purge webhook events
 * older than 90 days. Prevents unbounded growth of idempotency ledgers.
 *
 * Tables cleaned:
 * - hcp_webhook_events (Housecall Pro webhooks)
 * - fieldpulse_webhook_events (Fieldpulse webhooks)
 *
 * Retention: 90 days
 * Auth: CRON_SECRET Bearer token (fail closed if not configured)
 */

import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hcpWebhookEvents, fieldpulseWebhookEvents } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

interface CleanupSummary {
  readonly purgedHcpEvents: number;
  readonly purgedFieldpulseEvents: number;
  readonly totalPurged: number;
}

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/webhook-cleanup
 *
 * Purges webhook events older than 90 days from both HCP and Fieldpulse tables.
 */
export async function GET(request: NextRequest) {
  // Step 1: Auth check — validate Bearer token against CRON_SECRET.
  // Fail CLOSED if the secret is missing/blank: otherwise the expected token
  // collapses to "Bearer undefined" / "Bearer " and this destructive endpoint
  // (it purges webhook events) could be triggered by an unauthenticated
  // caller who guesses the misconfigured value.
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    logger.error({}, "CRON_SECRET is not configured; refusing webhook cleanup");
    return errorResponse(
      "Cron endpoint not configured",
      "NOT_CONFIGURED",
      503,
    );
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
    return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  }

  try {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    // Step 2: Purge old HCP webhook events
    const hcpResult = await db
      .delete(hcpWebhookEvents)
      .where(sql`${hcpWebhookEvents.createdAt} < ${ninetyDaysAgo}`);

    const purgedHcpEvents =
      (hcpResult as { rowCount?: number }).rowCount ?? 0;

    // Step 3: Purge old Fieldpulse webhook events
    const fieldpulseResult = await db
      .delete(fieldpulseWebhookEvents)
      .where(sql`${fieldpulseWebhookEvents.createdAt} < ${ninetyDaysAgo}`);

    const purgedFieldpulseEvents =
      (fieldpulseResult as { rowCount?: number }).rowCount ?? 0;

    const summary: CleanupSummary = {
      purgedHcpEvents,
      purgedFieldpulseEvents,
      totalPurged: purgedHcpEvents + purgedFieldpulseEvents,
    };

    logger.info({ webhookCleanup: summary }, "Webhook cleanup completed");

    return successResponse(summary);
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error({ error: errorMessage }, "Webhook cleanup failed");
    return errorResponse("Webhook cleanup failed", "INTERNAL_ERROR", 500);
  }
}
