/**
 * POST /api/admin/integrations/fieldpulse/webhook
 *
 * Inbound Fieldpulse webhook endpoint for job status and invoice updates.
 *
 * Fieldpulse sends webhooks for:
 * - Job status changes (e.g., "completed", "cancelled")
 * - Invoice events (e.g., "invoice.sent", "invoice.paid", "invoice.voided")
 *
 * This endpoint verifies the webhook signature (if configured), records the event
 * for idempotency, and updates the corresponding service request status or invoice
 * status.
 *
 * SECURITY FIXES (Phase 5):
 * - Organization ID is derived from fieldpulseJobId lookup, not trusted from payload
 * - Audit logging for all status changes
 * - Status-only update guard (no-op if status already matches)
 * - Proper error handling without information leakage
 *
 * INVOICE SYNC (Stage 7):
 * - Invoice events update the invoiceStatus field on service requests
 * - invoice.sent → "sent"
 * - invoice.paid → "paid"
 * - invoice.voided → "void"
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
import { syncInvoiceStatus } from "@/lib/integrations/fieldpulse/invoice-sync";
import { getFieldpulseWebhookSecret } from "@/lib/integrations/fieldpulse/config";
import {
  verifySignature,
  isReplayTimestamp,
  type SignatureVerificationResult,
} from "@/lib/integrations/fieldpulse/webhook-signature";

/**
 * Expected Fieldpulse webhook envelope (based on typical FSM patterns).
 * Adjust when actual Fieldpulse webhook docs are available.
 */
const webhookSchema = z.object({
  id: z.string(), // Event id for idempotency
  eventType: z.string(), // e.g., "job.status_updated", "invoice.sent"
  jobId: z.string().optional(), // The Fieldpulse job id (for job/invoice events)
  invoiceId: z.string().optional(), // The invoice id (for invoice events)
  // The new work status for job events. Preferred over deriving from eventType
  // (a "job.status_updated" eventType carries no status itself).
  status: z.string().optional(),
  workStatus: z.string().optional(),
  // Optional event timestamp (epoch s/ms or ISO) for replay protection.
  timestamp: z.union([z.number(), z.string()]).optional(),
  // NOTE: We DO NOT trust organizationId from the payload.
});

/**
 * Verify webhook signature using HMAC-SHA256.
 *
 * SECURITY BEHAVIOR:
 * - If FIELDPULSE_WEBHOOK_SECRET is configured: signature is REQUIRED
 * - If FIELDPULSE_WEBHOOK_SECRET is NOT configured: signature is OPTIONAL (dev mode)
 *
 * Expected signature format: x-fieldpulse-signature: sha256=<hex_signature>
 *
 * Returns a SignatureVerificationResult with valid flag and optional reason.
 */
function verifyWebhookSignature(
  body: string,
  signature: string | null,
  secret: string | null,
): SignatureVerificationResult {
  return verifySignature(body, signature, secret);
}

/**
 * Map a Fieldpulse job status to our request status enum.
 * Fieldpulse may use different status names; this mapping will need adjustment.
 */
function mapFieldpulseStatusToRequestStatus(
  fieldpulseStatus: string,
): "pending" | "assigned" | "scheduled" | "in_progress" | "on_hold" | "completed" | "cancelled" | null {
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
      // Unknown status — return null so the caller SKIPS rather than
      // destructively resetting the request to "pending".
      logger.warn(
        { fieldpulseStatus },
        "Unknown Fieldpulse status, skipping status update",
      );
      return null;
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

    const { id: eventId, eventType, jobId, invoiceId, timestamp } = parsed.data;

    // Replay protection: reject events whose timestamp is well outside the
    // allowed window (absent/odd timestamps are tolerated — the idempotency
    // ledger still stops exact duplicates).
    if (isReplayTimestamp(timestamp)) {
      logger.warn({ eventId, eventType }, "Fieldpulse webhook rejected: stale timestamp");
      return errorResponse("Stale request", "STALE_REQUEST", 401);
    }

    // Determine event type: job status or invoice
    const isInvoiceEvent = eventType.startsWith("invoice.");

    // SECURITY: Do NOT trust organizationId from webhook payload.
    // We'll derive it from the fieldpulseJobId lookup below.
    let organizationId: string | null = null;

    // For invoice events, we may need to look up via invoiceId if jobId is missing
    // For job events, we require jobId
    if (!jobId && !isInvoiceEvent) {
      logger.warn({ eventId, eventType }, "Fieldpulse webhook: missing jobId");
      return errorResponse("Invalid request", "INVALID_REQUEST", 400);
    }

    // First, look up the service request to get the orgId
    const requestRow = jobId
      ? (
          await db
            .select({
              id: serviceRequests.id,
              organizationId: serviceRequests.organizationId,
              status: serviceRequests.status,
              invoiceStatus: serviceRequests.invoiceStatus,
              fieldpulseJobId: serviceRequests.fieldpulseJobId,
            })
            .from(serviceRequests)
            .where(eq(serviceRequests.fieldpulseJobId, jobId))
        )[0]
      : null;

    if (!requestRow) {
      // No matching request - either not synced or invalid jobId
      // Return 200 so Fieldpulse doesn't retry (idempotent)
      logger.info(
        { eventId, eventType, jobId },
        "Fieldpulse webhook: no matching request",
      );
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

    // Verify signature against the org's OWN secret (decrypted), falling back to
    // the global env secret — not the env secret alone, which would ignore a
    // per-org secret configured at connect time.
    //
    // KNOWN TRADEOFF: signature verification runs AFTER the jobId lookup because
    // the per-org secret is keyed on the org we derive from that lookup. This
    // leaves a narrow job-id enumeration oracle (401 vs 200) for unauthenticated
    // callers. Accepted: job ids are low-value, and the idempotency ledger +
    // replay guard prevent any state change without a valid signature.
    const signature = request.headers.get("x-fieldpulse-signature");
    const secret = await getFieldpulseWebhookSecret(organizationId);
    const signatureResult = verifyWebhookSignature(rawBody, signature, secret);

    if (!signatureResult.valid) {
      logger.warn(
        { organizationId, eventId, reason: signatureResult.reason },
        "Fieldpulse webhook signature verification failed",
      );
      return errorResponse("Invalid signature", "INVALID_SIGNATURE", 401);
    }

    // Log if signature verification is skipped (no secret configured)
    if (signatureResult.reason === "no_secret_configured") {
      logger.info(
        { eventId, eventType },
        "Fieldpulse webhook: signature verification skipped (no secret configured)",
      );
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

    // Handle invoice events
    if (isInvoiceEvent) {
      // SECURITY: Invoice events MUST include jobId to link to our service request
      if (!jobId) {
        logger.warn(
          { eventId, eventType, invoiceId },
          "Invoice event missing jobId - cannot sync without job reference",
        );
        return errorResponse("Invalid request", "INVALID_REQUEST", 400);
      }

      // Extract invoice status from event type
      let invoiceStatus: string | null = null;
      if (eventType === "invoice.sent") {
        invoiceStatus = "sent";
      } else if (eventType === "invoice.paid") {
        invoiceStatus = "paid";
      } else if (eventType === "invoice.voided") {
        invoiceStatus = "void";
      }

      if (invoiceStatus) {
        await syncInvoiceStatus(jobId, invoiceStatus, organizationId);
        logger.info(
          { eventId, eventType, jobId, invoiceStatus },
          "Fieldpulse invoice webhook processed",
        );
        return new Response(null, { status: 204 });
      }

      // Unknown invoice event type - log but return 200 (don't retry)
      logger.warn({ eventType }, "Unknown invoice event type");
      return new Response(null, { status: 200 });
    }

    // Handle job status events. Prefer the explicit status field from the
    // payload; the eventType (e.g. "job.status_updated") carries no status. If
    // neither yields a known status, SKIP rather than reset the request.
    const rawStatus =
      parsed.data.status ?? parsed.data.workStatus ?? eventType;
    const newStatus = mapFieldpulseStatusToRequestStatus(rawStatus);

    if (newStatus === null) {
      logger.info(
        { eventId, eventType, jobId },
        "Fieldpulse webhook: no mappable job status, skipping",
      );
      return new Response(null, { status: 200 });
    }

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
