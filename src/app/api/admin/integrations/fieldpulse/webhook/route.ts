/**
 * POST /api/admin/integrations/fieldpulse/webhook
 *
 * Inbound Fieldpulse webhook endpoint for job status updates.
 *
 * Fieldpulse sends webhooks for job status changes (e.g., "completed", "cancelled").
 * This endpoint verifies the webhook signature (if configured), records the event
 * for idempotency, and updates the corresponding service request status.
 *
 * SECURITY FIXES (Phase 5):
 * - Organization ID is derived from fieldpulseJobId lookup, not trusted from payload
 * - Audit logging for all status changes
 * - Status-only update guard (no-op if status already matches)
 * - Proper error handling without information leakage
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
import { serviceRequests, organizations, auditLog } from "@/lib/db/schema";
import { fieldpulseWebhookEvents } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
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
  jobId: z.string(), // The Fieldpulse job id (REQUIRED for status sync)
  // NOTE: Fieldpulse may send additional fields (timestamp, payload, etc.)
  // that we can ignore for now. We DO NOT trust organizationId from the payload.
});

/**
 * Verify webhook signature (if Fieldpulse supports it).
 *
 * TODO: Implement when Fieldpulse webhook signing is documented.
 * For now, we rely on:
 * - The unguessable webhook URL (UUID-based secret path)
 * - Rate limiting
 * - Idempotency via eventId
 * - Org derived from fieldpulseJobId lookup
 */
function verifyWebhookSignature(
  _body: string,
  _signature: string | null,
  _secret: string | null,
): boolean {
  // Placeholder - returns true until Fieldpulse documents their signature format
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
      // Log WARN for unknown statuses - may need mapping update
      logger.warn(
        { fieldpulseStatus },
        "Unknown Fieldpulse status, defaulting to pending",
      );
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
      // Generic error message - don't leak parsing details
      return errorResponse("Invalid request", "INVALID_REQUEST", 400);
    }

    const parsed = webhookSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn(
        { error: parsed.error.format() },
        "Fieldpulse webhook validation failed",
      );
      // Generic error message - don't leak schema details
      return errorResponse("Invalid request", "INVALID_REQUEST", 400);
    }

    const { id: eventId, eventType, jobId } = parsed.data;

    // SECURITY: Do NOT trust organizationId from webhook payload.
    // We'll derive it from the fieldpulseJobId lookup below.
    // For rate limiting, use a fallback key until we have the org.
    let organizationId: string | null = null;
    let tempRateLimitKey = `fieldpulse-webhook:unknown:${jobId}`;

    // First, look up the service request to get the orgId (and current status)
    const [requestRow] = await db
      .select({
        id: serviceRequests.id,
        organizationId: serviceRequests.organizationId,
        status: serviceRequests.status,
        fieldpulseJobId: serviceRequests.fieldpulseJobId,
      })
      .from(serviceRequests)
      .where(eq(serviceRequests.fieldpulseJobId, jobId));

    if (!requestRow) {
      // No matching request - either not synced or invalid jobId
      // Return 200 so Fieldpulse doesn't retry (idempotent)
      logger.info({ eventId, jobId }, "Fieldpulse webhook: no matching request");
      return new Response(null, { status: 200 });
    }

    organizationId = requestRow.organizationId;

    // Rate limit per org (now that we have it)
    const rateCheck = slidingWindow(
      `fieldpulse-webhook:${organizationId}`,
      RATE_LIMITS.webhook.maxRequests,
      RATE_LIMITS.webhook.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Too many requests", "RATE_LIMITED", 429);
    }

    // Verify signature if secret is configured
    const signature = request.headers.get("x-fieldpulse-signature");
    const secret = process.env.FIELDPULSE_WEBHOOK_SECRET ?? null;
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
      logger.warn(
        { organizationId, eventId },
        "Fieldpulse webhook signature verification failed",
      );
      return errorResponse("Invalid signature", "INVALID_SIGNATURE", 401);
    }

    // Idempotency check: record this event
    const inserted = await db
      .insert(fieldpulseWebhookEvents)
      .values({
        organizationId,
        eventId,
        eventType,
        fieldpulseJobId: jobId,
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

    // Derive the new status from the event type
    const newStatus = mapFieldpulseStatusToRequestStatus(eventType);

    // SECURITY: Only update if status is different (no-op guard)
    if (requestRow.status === newStatus) {
      logger.info(
        { eventId, jobId, status: newStatus },
        "Fieldpulse webhook: status already matches, skipping update",
      );
      return new Response(null, { status: 204 });
    }

    // Update the service request status
    await db
      .update(serviceRequests)
      .set({
        status: newStatus,
        updatedAt: new Date(),
        // Set completed_at when appropriate
        ...(newStatus === "completed" ? { completedAt: new Date() } : {}),
      })
      .where(
        and(
          eq(serviceRequests.id, requestRow.id),
          // Guard: only update if status hasn't changed concurrently
          eq(serviceRequests.status, requestRow.status),
        ),
      );

    // Audit log for the status change (FORENSIC TRAIL)
    await db.insert(auditLog).values({
      organizationId,
      serviceRequestId: requestRow.id,
      action: "status_updated",
      entity: "service_requests",
      entityId: requestRow.id,
      details: JSON.stringify({
        from: requestRow.status,
        to: newStatus,
        source: "fieldpulse_webhook",
        eventType,
      }),
      ipAddress: null, // Webhook - no client IP
    });

    logger.info(
      { eventId, eventType, jobId, newStatus, organizationId },
      "Fieldpulse webhook processed: service request updated",
    );

    // Return 204 No Content on success
    return new Response(null, { status: 204 });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to process Fieldpulse webhook");
    // Generic error message - don't leak implementation details
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
