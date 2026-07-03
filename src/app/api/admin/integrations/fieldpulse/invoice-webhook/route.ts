/**
 * INVOICE SYNC: track Fieldpulse invoice status on our service requests.
 *
 * Mirrors housecall-pro invoice pattern: Fieldpulse sends invoice webhooks
 * (invoice.sent, invoice.paid, invoice.voided) and we update the request's
 * invoiceStatus column so admins can see billing state without leaving our
 * system.
 *
 * DEGRADE-SAFE: webhook failures are logged and never block the invoice in
 * Fieldpulse. Idempotent via fieldpulseWebhookEvents table.
 */
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { fieldpulseWebhookEvents } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { errorResponse } from "@/lib/api-response";
import { getFieldpulseWebhookSecret } from "@/lib/integrations/fieldpulse/config";
import {
  verifySignature,
  isReplayTimestamp,
} from "@/lib/integrations/fieldpulse/webhook-signature";
import { pullInvoiceFromFieldpulse } from "@/lib/integrations/fieldpulse/invoice-sync";
import { after } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Expected invoice webhook envelope from Fieldpulse. We DO NOT trust an
 * organizationId from the payload — it is derived from the jobId lookup.
 */
const invoiceWebhookSchema = z.object({
  id: z.string(), // Event id for idempotency
  eventType: z.string(), // invoice.sent, invoice.paid, invoice.voided
  jobId: z.string(), // The Fieldpulse job id (used to derive the org)
  // The Fieldpulse invoice id — optional so the legacy status-only path still
  // works without it. When present (and after the event is verified + deduped),
  // we pull the full money-grade invoice into the native `invoices` table.
  invoiceId: z.string().optional(),
  timestamp: z.union([z.number(), z.string()]).optional(), // for replay guard
});

/**
 * Map Fieldpulse invoice event types to our invoice status enum.
 */
function mapInvoiceEventToStatus(
  eventType: string,
): "sent" | "paid" | "void" | null {
  const normalized = eventType.toLowerCase();
  switch (normalized) {
    case "invoice.sent":
    case "invoice_created":
    case "invoice_sent":
      return "sent";
    case "invoice.paid":
    case "invoice_paid":
    case "payment_received":
      return "paid";
    case "invoice.voided":
    case "invoice_void":
    case "invoice_cancelled":
      return "void";
    default:
      // Unknown event → do NOT touch the status. Returning "none" here reset a
      // real paid/sent invoice to unpaid on any unrecognized webhook.
      logger.warn({ eventType }, "Unknown Fieldpulse invoice event type");
      return null;
  }
}

/**
 * POST /api/admin/integrations/fieldpulse/invoice-webhook
 *
 * Separate endpoint for invoice webhooks (different from job status webhooks).
 * Uses the same idempotency pattern and org derivation via jobId lookup.
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const rawBody = await request.text();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return errorResponse("Invalid request", "INVALID_REQUEST", 400);
    }

    const parsed = invoiceWebhookSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse("Invalid request", "INVALID_REQUEST", 400);
    }
    const { id: eventId, eventType, jobId, invoiceId, timestamp } = parsed.data;

    // Replay protection (absent/odd timestamps tolerated; ledger stops dupes).
    if (isReplayTimestamp(timestamp)) {
      logger.warn({ eventId, eventType }, "Fieldpulse invoice webhook rejected: stale timestamp");
      return errorResponse("Stale request", "STALE_REQUEST", 401);
    }

    // Look up the service request to get orgId
    const [requestRow] = await db
      .select({
        id: serviceRequests.id,
        organizationId: serviceRequests.organizationId,
        invoiceStatus: serviceRequests.invoiceStatus,
      })
      .from(serviceRequests)
      .where(eq(serviceRequests.fieldpulseJobId, jobId));

    if (!requestRow) {
      logger.info({ eventId, jobId }, "Fieldpulse invoice webhook: no matching request");
      return new Response(null, { status: 200 }); // Don't retry
    }

    const organizationId = requestRow.organizationId;

    // Rate limit per org
    const rateCheck = slidingWindow(
      `fieldpulse-invoice:${organizationId}`,
      RATE_LIMITS.webhook.maxRequests,
      RATE_LIMITS.webhook.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Too many requests", "RATE_LIMITED", 429);
    }

    // SECURITY: verify the HMAC signature against the org's secret (per-org,
    // env fallback). Without this, anyone could forge invoice.paid events and
    // flip billing state. Fail-closed when a secret is configured.
    //
    // KNOWN TRADEOFF: runs after the jobId lookup (per-org secret needs the org
    // derived from that lookup), leaving a narrow 401-vs-200 job-id enumeration
    // oracle. Accepted — no state change occurs without a valid signature.
    const signature = request.headers.get("x-fieldpulse-signature");
    const secret = await getFieldpulseWebhookSecret(organizationId);
    // Fail closed in production when no secret is configured (per-org or env).
    if (!secret && process.env.NODE_ENV === "production") {
      logger.error(
        { organizationId, eventId },
        "Fieldpulse invoice webhook rejected: no signing secret configured",
      );
      return errorResponse("Webhook not configured", "NOT_CONFIGURED", 401);
    }
    const signatureResult = verifySignature(rawBody, signature, secret);
    if (!signatureResult.valid) {
      logger.warn(
        { organizationId, eventId, reason: signatureResult.reason },
        "Fieldpulse invoice webhook signature verification failed",
      );
      return errorResponse("Invalid signature", "INVALID_SIGNATURE", 401);
    }

    // Idempotency check
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

    if (inserted.length === 0) {
      logger.info({ eventId }, "Fieldpulse invoice webhook: already processed");
      return new Response(null, { status: 200 });
    }

    // Map event to invoice status. null = unrecognized event → leave status as-is
    // (never reset a real paid/sent invoice on an unknown webhook).
    const newStatus = mapInvoiceEventToStatus(eventType);

    // Only update if we recognized the event AND the status is actually changing.
    if (newStatus !== null && requestRow.invoiceStatus !== newStatus) {
      await db
        .update(serviceRequests)
        .set({
          invoiceStatus: newStatus,
          updatedAt: new Date(),
        })
        .where(
          and(
            // Scope to the org we derived from the lookup (defense in depth on
            // top of the per-org unique fieldpulse_job_id index).
            eq(serviceRequests.organizationId, organizationId),
            eq(serviceRequests.id, requestRow.id),
            eq(serviceRequests.invoiceStatus, requestRow.invoiceStatus),
          ),
        );

      logger.info(
        { eventId, eventType, jobId, newStatus },
        "Fieldpulse invoice webhook: updated invoice status",
      );
    }

    // Money-grade mirror: pull the full invoice into the native `invoices` table.
    // Scheduled ONLY here — after signature verification + the idempotency ledger
    // insert (so a forged or replayed event never triggers a pull). Runs in the
    // background via after() so the webhook still returns fast; failures are
    // logged inside the module and recovered by the reconcile cron. Skipped when
    // the payload omits invoiceId (legacy status-only event).
    if (invoiceId) {
      after(() => pullInvoiceFromFieldpulse(organizationId, invoiceId));
    }

    return new Response(null, { status: 204 });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to process Fieldpulse invoice webhook");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
