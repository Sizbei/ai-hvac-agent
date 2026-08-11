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
import {
  serviceRequests,
  auditLog,
  invoices,
  invoiceLineItems,
  customers,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getFieldpulseClient } from "./client";
import { parseFpDate } from "./fp-dates";
import type { FieldpulseInvoiceStatus, FieldpulseInvoice } from "./types";
import { buildFpSpillover } from "./import/spillover";
import { displayQuantity } from "./line-item-display";
import { makeFpCustomerHealer } from "./import/customers";

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

    // Find the service request by fieldpulseJobId — SCOPED TO THE ORG so a
    // cross-tenant fieldpulse_job_id collision can never mutate another org's
    // invoice state (organizationId was previously used only for the audit log).
    const [requestRow] = await db
      .select({
        id: serviceRequests.id,
        invoiceStatus: serviceRequests.invoiceStatus,
      })
      .from(serviceRequests)
      .where(
        and(
          eq(serviceRequests.organizationId, organizationId),
          eq(serviceRequests.fieldpulseJobId, fieldpulseJobId),
        ),
      );

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
          eq(serviceRequests.organizationId, organizationId),
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

// ─── Money-grade PULL MIRROR (read-only Fieldpulse → native `invoices` table) ──
//
// The functions above mirror only a status enum onto service_requests. The pull
// mirror below lands the full Fieldpulse invoice (total, state) as a row in the
// native `invoices` table, idempotent on `fieldpulseInvoiceId`. Fieldpulse stays
// the money authority: synced rows are read-only (native takePayment/refund/
// reconcile refuse them — see invoice-queries.ts). See the 2026-06-19 spec.

export type InvoicePullOutcome = "created" | "updated" | "skipped" | "failed";

/**
 * Map a Fieldpulse invoice status to the NATIVE `invoices.state` enum
 * (draft|open|paid|void). Distinct from `mapInvoiceStatus` above, which targets
 * the service_requests.invoiceStatus enum (none|sent|paid|void) — keep BOTH in
 * step if Fieldpulse's status vocabulary changes. `refunded` is native-only and
 * is never produced from a Fieldpulse pull.
 */
export function mapFieldpulseStatusToInvoiceState(
  status: string | null | undefined,
): "draft" | "open" | "paid" | "void" {
  if (!status) return "draft";
  switch (status.toLowerCase()) {
    case "sent":
    case "emailed":
    case "viewed":
    case "overdue":
      return "open";
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
      return "draft";
  }
}

/**
 * Derive the native `invoices.state` from the invoice's AMOUNTS — authoritative,
 * unlike the real API's opaque integer `status` (whose code meanings are
 * unconfirmed). Paid when nothing is owed; open once invoiced; draft otherwise.
 * (Void isn't derivable from amounts; the webhook's invoice.voided event drives
 * the request-status void path separately.)
 */
function deriveInvoiceState(
  invoice: FieldpulseInvoice,
  totalCents: number,
  amountPaidCents: number,
): "draft" | "open" | "paid" | "void" {
  if (totalCents <= 0) return "draft";
  const unpaid = invoice.amountUnpaidCents;

  // `amount_unpaid` alone is not sufficient evidence of payment. FieldPulse
  // emits a class of invoices with total > 0, amount_paid 0.00, amount_unpaid
  // 0.00, no payments and no first_payment_date — internally contradictory,
  // since a zero balance on a positive total implies someone paid. Trusting the
  // balance field made us record those as fully paid: AR understated,
  // collections never chasing them, the accounting export calling them
  // collected. Live check on the dev mirror: 102 invoices, and on the ones
  // sampled upstream FieldPulse's own `status` reads open, not paid.
  //
  // So require positive evidence: a non-zero paid amount, or a payment date. If
  // neither exists, ignore the balance field and fall back to the amounts.
  const hasPaymentEvidence = amountPaidCents > 0 || invoice.paidAt != null;
  const fullyPaid =
    unpaid != null && hasPaymentEvidence
      ? unpaid <= 0
      : amountPaidCents >= totalCents;
  return fullyPaid ? "paid" : "open";
}

/**
 * Build native `invoice_line_items` rows from the mirrored FieldPulse lines.
 * costCents / lineTotalCents are TOTALS (qty × unit) — the shape rollUpMargin
 * expects (revenue = Σ lineTotalCents, cost = Σ costCents).
 */
function lineItemRows(
  organizationId: string,
  invoiceId: string,
  invoice: FieldpulseInvoice,
): Array<{
  organizationId: string;
  invoiceId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  costCents: number;
  lineTotalCents: number;
}> {
  return (invoice.lineItems ?? []).map((li) => ({
    organizationId,
    invoiceId,
    name: li.name,
    // Display only; the MONEY below uses the exact fractional quantity so a
    // 2.5-hr line isn't billed as 3. See displayQuantity for why neither a
    // floor of 0 nor a floor of 1 is correct on its own.
    quantity: displayQuantity(li.quantity),
    unitPriceCents: li.unitPriceCents,
    costCents: Math.round(li.quantity * li.unitCostCents),
    lineTotalCents: Math.round(li.quantity * li.unitPriceCents),
  }));
}

/**
 * Core upsert for one already-fetched Fieldpulse invoice. Shared by the
 * single-invoice and per-job entry points so the cron doesn't re-fetch.
 * Resolves links org-scoped, maps money to cents, and find-or-creates the native
 * row idempotently on (org, fieldpulseInvoiceId). May throw — callers catch.
 *
 * Exported so the Phase 5 backfill (import/invoices.ts) can feed already-fetched
 * invoices in without the N wasteful re-fetches that pullInvoiceFromFieldpulse adds.
 *
 * `healCustomer` is optional: when omitted the customer link resolves by strict
 * fp-id only (unchanged behaviour). Callers that hold a FieldPulse client pass
 * `makeFpCustomerHealer(...)` so a customer the strict lookup can't see is
 * fetched and resolved rather than left orphaned.
 */
export async function upsertInvoiceRecord(
  organizationId: string,
  invoice: FieldpulseInvoice,
  healCustomer?: (fpCustomerId: string) => Promise<string | null>,
): Promise<InvoicePullOutcome> {
  // A DELETED FieldPulse invoice must never become live AR. The importer skips
  // these, but this function is also the webhook and daily-cron entry point,
  // and neither checked — so a deleted invoice arriving by webhook was mirrored
  // as an open balance, given a customer, and handed to collections. Nothing
  // downstream corrects it: deriveInvoiceState can only return draft/open/paid,
  // never void.
  //
  // Refusing to create it is the safe half. An invoice mirrored BEFORE it was
  // deleted upstream is the other half, and that one is not ours to decide
  // silently — voiding a row is a money mutation, so it is surfaced for a human
  // rather than performed here.
  if (invoice.deletedAt != null) {
    const [stale] = await db
      .select({ id: invoices.id, state: invoices.state })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          eq(invoices.fieldpulseInvoiceId, invoice.id),
        ),
      );
    if (stale && stale.state !== "void") {
      logger.warn(
        { organizationId, fieldpulseInvoiceId: invoice.id, localState: stale.state },
        "FieldPulse invoice is deleted upstream but the mirror still shows it as live — needs review",
      );
    }
    return "skipped";
  }

  const totalCents = invoice.totalCents ?? 0;
  // FP sends real subtotal + tax; fall back to total/0 only if absent so the
  // invoice document shows the true tax line (tax > 0 on ~56% of invoices),
  // not a fabricated $0.00. subtotal defaults to total (pre-tax == total when
  // untaxed).
  const taxCents = invoice.taxCents ?? 0;
  // subtotal = total - tax, NOT FP's raw `subtotal` (that is PRE-discount and
  // won't reconcile — verified: FP subtotal_discounted + tax == total). This
  // form always ties out on the invoice document.
  const subtotalCents = totalCents - taxCents;
  // Real API exposes accurate paid/unpaid amounts — use them (no longer binary).
  const rawAmountPaidCents = invoice.amountPaidCents ?? 0;
  const state = deriveInvoiceState(invoice, totalCents, rawAmountPaidCents);
  // H2 guard: a paid invoice has zero balance by definition. If FP sends state
  // 'paid' but amount_paid=0 (absent or zeroed-out in the payload), correct the
  // paid amount to totalCents so the invoice never shows as outstanding.
  const amountPaidCents =
    state === "paid" && rawAmountPaidCents === 0 ? totalCents : rawAmountPaidCents;

  // Resolve links — both optional, both ORG-SCOPED compound keys so a
  // cross-tenant Fieldpulse-id collision can't attach to the wrong tenant.
  let serviceRequestId: string | null = null;
  if (invoice.jobId) {
    const [r] = await db
      .select({ id: serviceRequests.id })
      .from(serviceRequests)
      .where(
        and(
          eq(serviceRequests.organizationId, organizationId),
          eq(serviceRequests.fieldpulseJobId, invoice.jobId),
        ),
      );
    serviceRequestId = r?.id ?? null;
  }
  let customerId: string | null = null;
  if (invoice.customerId) {
    const [c] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.organizationId, organizationId),
          eq(customers.fieldpulseCustomerId, invoice.customerId),
        ),
      );
    customerId = c?.id ?? null;

    // A missed link is not cosmetic: an invoice with no customer is invisible
    // to collections — no reminder, no pay link, no AR owner — so the money
    // silently stops being chaseable. The strict fp-id lookup above misses
    // whenever the customer's fp id was never written to a row (shared billing
    // contacts, list-pagination gaps — see makeFpCustomerHealer). Live count on
    // the dev mirror before this heal existed: 506 orphaned FP invoices, 93 of
    // them unpaid, holding four figures of AR that no screen could route to
    // anyone. (Exact figures deliberately not recorded here — this repo is
    // public and they are the operator's business data.)
    if (!customerId && healCustomer) {
      customerId = await healCustomer(invoice.customerId);
    }
  }

  const [existing] = await db
    .select({ id: invoices.id, state: invoices.state })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.fieldpulseInvoiceId, invoice.id),
      ),
    );

  // Spillover: build from the raw FP invoice payload (snake_case fields).
  // invoice._raw is threaded through toInvoice(); the denylist model captures
  // any unpromoted, non-denied primitive long-tail fields FP may carry.
  const fpSpillover = buildFpSpillover(invoice._raw ?? {}, "invoices");

  if (existing) {
    // Re-sync: update money/state, REPLACE line items (reflect current FP state),
    // + audit — atomically (single implicit txn).
    const liRows = lineItemRows(organizationId, existing.id, invoice);
    await db.batch([
      db
        .update(invoices)
        .set({
          state,
          subtotalCents,
          taxCents,
          totalCents,
          amountPaidCents,
          // Re-link on update, but NEVER un-link. An invoice first synced
          // before its customer existed locally used to stay orphaned forever:
          // this branch refreshed the money but not the FK, so no number of
          // re-pulls could ever repair it. That is how 11 open invoices came to
          // hold real AR with no customer profile and no way to
          // send a reminder.
          //
          // Only overwrite when we actually resolved someone. Spreading a null
          // would erase a good link whenever a later sync failed to resolve —
          // trading a repairable gap for a destructive one.
          // Real-world issue date: FP's invoiced_date. For QB-originated
          // invoices, created_at is the day the row was BULK-IMPORTED into FP
          // (live-verified: fp#20824708 invoiced 2025-10-30, created
          // 2026-07-07) — using it flattened all aging to the import day.
          // Written on UPDATE too so re-imports backfill older rows.
          ...(customerId ? { customerId } : {}),
          ...(serviceRequestId ? { serviceRequestId } : {}),
          issuedAt: parseFpDate(invoice.invoicedDate ?? invoice.createdAt),
          dueDate: parseFpDate(invoice.dueDate),
          fieldpulseData: fpSpillover,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(invoices.organizationId, organizationId),
            eq(invoices.id, existing.id),
          ),
        ),
      db
        .delete(invoiceLineItems)
        .where(
          and(
            eq(invoiceLineItems.organizationId, organizationId),
            eq(invoiceLineItems.invoiceId, existing.id),
          ),
        ),
      ...(liRows.length ? [db.insert(invoiceLineItems).values(liRows)] : []),
      db.insert(auditLog).values({
        organizationId,
        action: "invoice_synced",
        entity: "invoices",
        entityId: existing.id,
        details: JSON.stringify({
          from: existing.state,
          to: state,
          source: "fieldpulse_invoice_pull",
          fieldpulseInvoiceId: invoice.id,
        }),
        ipAddress: null,
      }),
    ]);
    if (invoice.jobId) await syncInvoiceStatus(invoice.jobId, invoice.status, organizationId);
    return "updated";
  }

  // First sight: insert, racing safely on the per-org partial unique index.
  const inserted = await db
    .insert(invoices)
    .values({
      organizationId,
      fieldpulseInvoiceId: invoice.id,
      serviceRequestId,
      customerId,
      state,
      subtotalCents,
      taxCents,
      totalCents,
      amountPaidCents,
      // invoiced_date, not created_at — see the upsert branch comment.
      issuedAt: parseFpDate(invoice.invoicedDate ?? invoice.createdAt),
      dueDate: parseFpDate(invoice.dueDate),
      fieldpulseData: fpSpillover,
    })
    .onConflictDoNothing()
    .returning({ id: invoices.id });

  if (inserted.length > 0) {
    const liRows = lineItemRows(organizationId, inserted[0].id, invoice);
    await db.batch([
      db.insert(auditLog).values({
        organizationId,
        action: "invoice_synced",
        entity: "invoices",
        entityId: inserted[0].id,
        details: JSON.stringify({
          from: "new",
          to: state,
          source: "fieldpulse_invoice_pull",
          fieldpulseInvoiceId: invoice.id,
        }),
        ipAddress: null,
      }),
      ...(liRows.length ? [db.insert(invoiceLineItems).values(liRows)] : []),
    ]);
    if (invoice.jobId) await syncInvoiceStatus(invoice.jobId, invoice.status, organizationId);
    return "created";
  }

  // Lost the race — a concurrent pull created it. The winner's write is current
  // (the pull always reflects current Fieldpulse state), so report "updated",
  // never "created" (keeps batch metrics honest).
  const [now] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.fieldpulseInvoiceId, invoice.id),
      ),
    );
  return now ? "updated" : "skipped";
}

/**
 * Pull one Fieldpulse invoice into the native `invoices` table (read-only mirror).
 * Always fetches CURRENT Fieldpulse state, so webhook event ordering is
 * irrelevant. Degrade-safe: not-connected / missing invoice / any error returns
 * an outcome, never throws.
 */
export async function pullInvoiceFromFieldpulse(
  organizationId: string,
  fieldpulseInvoiceId: string,
  fetchImpl?: typeof fetch,
): Promise<InvoicePullOutcome> {
  try {
    const client = await getFieldpulseClient(organizationId, fetchImpl);
    if (!client) return "skipped";
    const invoice = await client.getInvoice(fieldpulseInvoiceId);
    if (!invoice) return "skipped";
    // Heal here too, or the webhook path keeps minting fresh orphans between
    // nightly sweeps — the day-to-day source of the backlog, not just its history.
    return await upsertInvoiceRecord(
      organizationId,
      invoice,
      makeFpCustomerHealer(organizationId, client),
    );
  } catch (error) {
    logger.warn(
      { error, fieldpulseInvoiceId },
      "Fieldpulse invoice pull failed (degraded)",
    );
    return "failed";
  }
}

/**
 * Pull every Fieldpulse invoice for a job (reconcile-cron backstop for missed or
 * failed webhook pulls). Isolates per-invoice failures so one bad invoice never
 * aborts the sweep. Degrade-safe.
 */
export async function pullInvoicesForJob(
  organizationId: string,
  fieldpulseJobId: string,
  fetchImpl?: typeof fetch,
): Promise<{ created: number; updated: number; skipped: number; failed: number }> {
  const summary = { created: 0, updated: 0, skipped: 0, failed: 0 };
  try {
    const client = await getFieldpulseClient(organizationId, fetchImpl);
    if (!client) return summary;
    const list = await client.listJobInvoices(fieldpulseJobId);
    // One healer for the whole job: its invoices usually share a customer, so
    // the cache turns N lookups into 1. Without this the daily reconcile cron
    // — the backstop for missed webhooks — inserts orphans of its own, which
    // is the exact leak the healer was added to stop.
    const healCustomer = makeFpCustomerHealer(organizationId, client);
    for (const inv of list) {
      let outcome: InvoicePullOutcome;
      try {
        outcome = await upsertInvoiceRecord(organizationId, inv, healCustomer);
      } catch (error) {
        logger.warn(
          { error, fieldpulseInvoiceId: inv.id },
          "Fieldpulse invoice pull failed for job invoice (degraded)",
        );
        outcome = "failed";
      }
      summary[outcome]++;
    }
  } catch (error) {
    logger.warn({ error, fieldpulseJobId }, "Fieldpulse job-invoice pull failed (degraded)");
  }
  return summary;
}
