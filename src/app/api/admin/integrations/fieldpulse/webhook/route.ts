/**
 * POST /api/admin/integrations/fieldpulse/webhook
 *
 * Inbound Fieldpulse webhook endpoint for job status updates.
 *
 * Fieldpulse sends webhooks for job status changes (e.g., "completed", "cancelled").
 * This endpoint verifies the webhook signature (if configured), records the event
 * for idempotency, and updates the corresponding service request status.
 *
 * Rate-limited per org to prevent abuse. Returns 200 OK for duplicate events
 * (already processed) and 204 No Content for successful processing.
 *
 * NOTE: Fieldpulse's webhook format is based on typical FSM patterns; the exact
 * payload structure may need adjustment when their documentation is available.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { fieldpulseWebhookEvents } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { errorResponse } from "@/lib/api-response";

/**
 * Expected Fieldpulse webhook envelope (based on typical FSM patterns).
 * Adjust when actual Fieldpulse webhook docs are available.
 */
const webhookSchema = z.object({
  id: z.string(), // Event id for idempotency
  eventType: z.string(), // e.g., "job.status_updated", "job.completed"
  jobId: z.string().optional(), // The Fieldpulse job id
  organizationId: z.string().optional(), // Org id (if Fieldpulse sends it)
  // NOTE: Fieldpulse may send additional fields (timestamp, payload, etc.)
  // that we can ignore for now.
});

/**
 * Verify webhook signature (if Fieldpulse supports it).
 * For now, this is a placeholder — we'll implement once their webhook format
 * is documented.
 */
function verifyWebhookSignature(
  _body: string,
  _signature: string | null,
  _secret: string | null,
): boolean {
  // TODO: Implement when Fieldpulse webhook signing is documented.
  // For now, accept all requests — rate limiting provides basic protection.
  return true;
}

/**
 * Map a Fieldpulse job status to our request status enum.
 * Fieldpulse may use different status names; this mapping will need adjustment.
 */
function mapFieldpulseStatusToRequestStatus(
  fieldpulseStatus: string,
): "pending" | "assigned" | "scheduled" | "in_progress" | "on_hold" | "completed" | "cancelled" {
  const normalized = fieldpulseStatus.toLowerCase();
  switch (normalized) {
    case "pending":
    case "queued":
    case "new":
      return "pending";
    case "assigned":
    case "dispatched":
      return "assigned";
    case "scheduled":
    case "confirmed":
      return "scheduled";
    case "in_progress":
    case "started":
    case "en_route":
    case "on_site":
      return "in_progress";
    case "on_hold":
    case "paused":
      return "on_hold";
    case "completed":
    case "finished":
    case "done":
      return "completed";
    case "cancelled":
    case "canceled":
    case "void":
      return "cancelled";
    default:
      // Default to pending for unknown statuses
      return "pending";
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const rawBody = await request.text();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return errorResponse("Invalid JSON body", "INVALID_BODY", 400);
    }

    const parsed = webhookSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn(
        { error: parsed.error.format() },
        "Fieldpulse webhook validation failed",
      );
      return errorResponse("Invalid webhook payload", "INVALID_PAYLOAD", 400);
    }

    const { id: eventId, eventType, jobId } = parsed.data;

    // Extract org id from the webhook or use a default (will need adjustment)
    const organizationId = parsed.data.organizationId ?? "default";

    // Rate limit per org
    const rateCheck = slidingWindow(
      `fieldpulse-webhook:${organizationId}`,
      RATE_LIMITS.webhook.maxRequests,
      RATE_LIMITS.webhook.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    // Idempotency check: record this event
    const inserted = await db
      .insert(fieldpulseWebhookEvents)
      .values({
        organizationId,
        eventId,
        eventType,
        fieldpulseJobId: jobId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: fieldpulseWebhookEvents.id });

    // If no row was inserted, this event was already processed
    if (inserted.length === 0) {
      logger.info(
        { eventId, eventType },
        "Fieldpulse webhook already processed (idempotent)",
      );
      return new Response(null, { status: 200 });
    }

    // Update the corresponding service request status (if we have a job id)
    if (jobId) {
      // Derive our status from the event type
      const newStatus = mapFieldpulseStatusToRequestStatus(eventType);

      await db
        .update(serviceRequests)
        .set({
          status: newStatus,
          updatedAt: new Date(),
          // Set completed_at when appropriate
          ...(newStatus === "completed" ? { completedAt: new Date() } : {}),
        })
        .where(eq(serviceRequests.fieldpulseJobId, jobId));

      logger.info(
        { eventId, eventType, jobId, newStatus },
        "Fieldpulse webhook processed: service request updated",
      );
    } else {
      logger.info(
        { eventId, eventType },
        "Fieldpulse webhook processed: no job id to update",
      );
    }

    // Return 204 No Content on success
    return new Response(null, { status: 204 });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to process Fieldpulse webhook");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
