/**
 * Fieldpulse Invoice Sync
 *
 * Handles invoice status synchronization from Fieldpulse to our service requests.
 * This module maps Fieldpulse invoice events to our invoiceStatus enum values:
 * - "invoice.sent" → "sent"
 * - "invoice.paid" → "paid"
 * - "invoice.voided" → "void"
 *
 * The sync is idempotent and resilient to missing or malformed data.
 *
 * (Stage 7 of the Fieldpulse integration.)
 */

import { db } from "@/lib/db";
import { serviceRequests, auditLog } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";
import type { FieldpulseInvoiceStatus } from "./types";

/**
 * Map a Fieldpulse invoice status to our invoice status enum.
 *
 * Fieldpulse may use different status names; this mapping is based on typical
 * FSM invoice workflows and should be adjusted when actual Fieldpulse docs are
 * available.
 */
function mapInvoiceStatus(
  fieldpulseStatus: string | null | undefined,
): "none" | "sent" | "paid" | "void" {
  if (!fieldpulseStatus) {
    return "none";
  }

  const normalized = fieldpulseStatus.toLowerCase();
  switch (normalized) {
    case "sent":
    case "emailed":
    case "viewed":
      return "sent";
    case "paid":
    case "payment_received":
    case "complete":
      return "paid";
    case "void":
    case "voided":
    case "cancelled":
    case "canceled":
      return "void";
    case "draft":
    case "pending":
    default:
      // Draft/pending invoices don't count as "sent" yet
      return "none";
  }
}

/**
 * Update a service request's invoice status based on Fieldpulse invoice data.
 *
 * This is called from:
 * 1. The webhook handler when an invoice event is received
 * 2. A periodic sync job that polls for invoice updates
 *
 * Idempotent: updating to the same status is a no-op. Resilient: missing
 * job_id or malformed data are logged and skipped, not thrown.
 *
 * @param fieldpulseJobId - The Fieldpulse job id to update
 * @param invoiceStatus - The invoice status from Fieldpulse
 * @param organizationId - The organization id (for audit logging)
 * @returns "updated" when the status changed, "skipped" for a benign no-op
 *   (no matching request, or status already current), "failed" only on error.
 *   Distinguishing skip from fail keeps batch metrics honest.
 */
export type InvoiceSyncOutcome = "updated" | "skipped" | "failed";

export async function syncInvoiceStatus(
  fieldpulseJobId: string,
  invoiceStatus: FieldpulseInvoiceStatus | string | null | undefined,
  organizationId: string,
): Promise<InvoiceSyncOutcome> {
  try {
    // Map the Fieldpulse status to our enum
    const newStatus = mapInvoiceStatus(invoiceStatus);

    // Find the service request by fieldpulseJobId
    const [requestRow] = await db
      .select({
        id: serviceRequests.id,
        invoiceStatus: serviceRequests.invoiceStatus,
      })
      .from(serviceRequests)
      .where(eq(serviceRequests.fieldpulseJobId, fieldpulseJobId));

    if (!requestRow) {
      logger.warn(
        { fieldpulseJobId, invoiceStatus },
        "Invoice sync: no matching service request found",
      );
      return "skipped";
    }

    // Guard: only update if status is changing
    if (requestRow.invoiceStatus === newStatus) {
      logger.debug(
        { fieldpulseJobId, status: newStatus },
        "Invoice sync: status already matches, skipping",
      );
      return "skipped";
    }

    // Update the invoice status
    await db
      .update(serviceRequests)
      .set({
        invoiceStatus: newStatus,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(serviceRequests.id, requestRow.id),
          // Guard: only update if status hasn't changed concurrently
          eq(serviceRequests.invoiceStatus, requestRow.invoiceStatus),
        ),
      );

    // Audit log for the invoice status change
    await db.insert(auditLog).values({
      organizationId,
      action: "invoice_status_updated",
      entity: "service_requests",
      entityId: requestRow.id,
      details: JSON.stringify({
        from: requestRow.invoiceStatus,
        to: newStatus,
        source: "fieldpulse_invoice_sync",
        fieldpulseJobId,
      }),
      ipAddress: null, // Sync job - no client IP
    });

    logger.info(
      {
        fieldpulseJobId,
        requestId: requestRow.id,
        from: requestRow.invoiceStatus,
        to: newStatus,
      },
      "Invoice sync: updated service request invoice status",
    );

    return "updated";
  } catch (error) {
    logger.error({ error, fieldpulseJobId }, "Invoice sync: failed to update");
    return "failed";
  }
}

/**
 * Batch sync invoice statuses for multiple Fieldpulse jobs.
 *
 * Used by periodic sync jobs to efficiently update many requests at once.
 * Processes each update independently; failures for individual jobs don't
 * abort the entire batch.
 *
 * @param updates - Array of { fieldpulseJobId, invoiceStatus, organizationId }
 * @returns Summary of successes and failures
 */
export async function batchSyncInvoiceStatuses(
  updates: Array<{
    fieldpulseJobId: string;
    invoiceStatus: FieldpulseInvoiceStatus | string | null | undefined;
    organizationId: string;
  }>,
): Promise<{ success: number; skipped: number; failed: number }> {
  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const update of updates) {
    const result = await syncInvoiceStatus(
      update.fieldpulseJobId,
      update.invoiceStatus,
      update.organizationId,
    );
    if (result === "updated") {
      success++;
    } else if (result === "skipped") {
      skipped++;
    } else {
      failed++;
    }
  }

  logger.info(
    { total: updates.length, success, skipped, failed },
    "Invoice batch sync completed",
  );

  return { success, skipped, failed };
}

/**
 * Determine the current invoice status for a job by querying Fieldpulse.
 *
 * This is a fallback for when webhooks are missed or delayed. It fetches
 * the latest invoices for a job and derives the status from the most recent
 * one.
 *
 * @param fieldpulseJobId - The Fieldpulse job id
 * @param invoices - List of invoices from Fieldpulse (newest first)
 * @returns The derived invoice status ("none", "sent", "paid", or "void")
 */
export function deriveInvoiceStatusFromInvoices(
  invoices: ReadonlyArray<{ status: string | null | undefined }>,
): "none" | "sent" | "paid" | "void" {
  if (!invoices || invoices.length === 0) {
    return "none";
  }

  // Get the most recent invoice's status
  const latestStatus = invoices[0]?.status;
  return mapInvoiceStatus(latestStatus);
}
