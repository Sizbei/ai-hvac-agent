/**
 * Housecall Pro invoice PULL MIRROR (read-only HCP → native `invoices` table).
 *
 * Parity port of fieldpulse/invoice-sync.ts's money-grade pull, with hardcoded
 * HCP columns. HCP stays the money authority: synced rows (hcp_invoice_id set)
 * are read-only — native takePayment/refund/reconcile refuse them (invoice-
 * queries.ts). Idempotent on (org, hcpInvoiceId). Degrade-safe.
 *
 * Deliberately DUPLICATED rather than sharing a parameterized core with
 * FieldPulse (Drizzle fights dynamic columns; the shared core would have dropped
 * FieldPulse's request-badge mirror). See the 2026-06-19 HCP parity spec.
 */
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoices, customers, serviceRequests, auditLog } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { getHousecallClient } from "./client";
// Same normalizing parser as the FieldPulse mirror (pure module) — HCP dates
// are ISO and pass through it unchanged.
import { parseFpDate } from "../fieldpulse/fp-dates";
import type { HousecallInvoice } from "./types";

export type InvoicePullOutcome = "created" | "updated" | "skipped" | "failed";

/** HCP invoice status → native `invoices.state`. `refunded` is native-only. */
export function mapHousecallStatusToInvoiceState(
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

/** HCP invoice status → service_requests.invoiceStatus badge enum. */
export function mapHousecallStatusToRequestInvoiceStatus(
  status: string | null | undefined,
): "none" | "sent" | "paid" | "void" {
  const state = mapHousecallStatusToInvoiceState(status);
  // open → "sent" (an open invoice has been sent); draft → "none".
  return state === "open" ? "sent" : state === "draft" ? "none" : state;
}

/**
 * Best-effort mirror of the request badge (service_requests.invoiceStatus), to
 * match FieldPulse's pull. Isolated try/catch so a badge failure never fails the
 * money sync. No separate audit — the invoice_synced audit already records it.
 */
async function mirrorRequestBadge(
  organizationId: string,
  hcpJobId: string | null | undefined,
  status: string | null | undefined,
): Promise<void> {
  if (!hcpJobId) return;
  try {
    const newStatus = mapHousecallStatusToRequestInvoiceStatus(status);
    await db
      .update(serviceRequests)
      .set({ invoiceStatus: newStatus, updatedAt: new Date() })
      .where(
        and(
          eq(serviceRequests.organizationId, organizationId),
          eq(serviceRequests.hcpJobId, hcpJobId),
        ),
      );
  } catch (error) {
    logger.warn({ error, hcpJobId }, "HCP invoice badge mirror failed (degraded)");
  }
}

/** Core upsert for one already-fetched HCP invoice. May throw — callers catch. */
async function upsertHcpInvoiceRecord(
  organizationId: string,
  invoice: HousecallInvoice,
): Promise<InvoicePullOutcome> {
  const state = mapHousecallStatusToInvoiceState(invoice.status);
  const totalCents = invoice.total ?? 0;
  const amountPaidCents = state === "paid" ? totalCents : 0;

  let serviceRequestId: string | null = null;
  if (invoice.jobId) {
    const [r] = await db
      .select({ id: serviceRequests.id })
      .from(serviceRequests)
      .where(
        and(
          eq(serviceRequests.organizationId, organizationId),
          eq(serviceRequests.hcpJobId, invoice.jobId),
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
          eq(customers.hcpCustomerId, invoice.customerId),
        ),
      );
    customerId = c?.id ?? null;
  }

  const [existing] = await db
    .select({ id: invoices.id, state: invoices.state })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.hcpInvoiceId, invoice.id),
      ),
    );

  if (existing) {
    await db.batch([
      db
        .update(invoices)
        .set({
          state,
          subtotalCents: totalCents,
          totalCents,
          amountPaidCents,
          // Real-world dates from HCP (issuedAt = created there). Written on
          // UPDATE too so a re-sync backfills rows that predate these columns.
          issuedAt: parseFpDate(invoice.createdAt),
          dueDate: parseFpDate(invoice.dueDate),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(invoices.organizationId, organizationId),
            eq(invoices.id, existing.id),
          ),
        ),
      db.insert(auditLog).values({
        organizationId,
        action: "invoice_synced",
        entity: "invoices",
        entityId: existing.id,
        details: JSON.stringify({
          from: existing.state,
          to: state,
          source: "housecall_invoice_pull",
          hcpInvoiceId: invoice.id,
          totalCents,
        }),
        ipAddress: null,
      }),
    ]);
    await mirrorRequestBadge(organizationId, invoice.jobId, invoice.status);
    return "updated";
  }

  const inserted = await db
    .insert(invoices)
    .values({
      organizationId,
      hcpInvoiceId: invoice.id,
      serviceRequestId,
      customerId,
      state,
      subtotalCents: totalCents,
      taxCents: 0,
      totalCents,
      amountPaidCents,
      issuedAt: parseFpDate(invoice.createdAt),
      dueDate: parseFpDate(invoice.dueDate),
    })
    .onConflictDoNothing()
    .returning({ id: invoices.id });

  if (inserted.length > 0) {
    await db.insert(auditLog).values({
      organizationId,
      action: "invoice_synced",
      entity: "invoices",
      entityId: inserted[0].id,
      details: JSON.stringify({
        from: "new",
        to: state,
        source: "housecall_invoice_pull",
        hcpInvoiceId: invoice.id,
        totalCents,
      }),
      ipAddress: null,
    });
    await mirrorRequestBadge(organizationId, invoice.jobId, invoice.status);
    return "created";
  }

  // Lost the insert race — a concurrent pull created it. Report "updated".
  const [now] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.hcpInvoiceId, invoice.id),
      ),
    );
  return now ? "updated" : "skipped";
}

/**
 * Pull one HCP invoice into the native `invoices` table (read-only mirror).
 * Always fetches CURRENT HCP state, so webhook event ordering is irrelevant.
 * Degrade-safe: not-connected / missing invoice / any error returns an outcome.
 */
export async function pullInvoiceFromHousecall(
  organizationId: string,
  hcpInvoiceId: string,
  fetchImpl?: typeof fetch,
): Promise<InvoicePullOutcome> {
  try {
    const client = await getHousecallClient(organizationId, fetchImpl);
    if (!client) return "skipped";
    const invoice = await client.getInvoice(hcpInvoiceId);
    if (!invoice) return "skipped";
    return await upsertHcpInvoiceRecord(organizationId, invoice);
  } catch (error) {
    logger.warn({ error, hcpInvoiceId }, "HCP invoice pull failed (degraded)");
    return "failed";
  }
}

/**
 * Pull every HCP invoice for a job (reconcile-cron backstop). Isolates
 * per-invoice failures so one bad invoice never aborts the sweep. Degrade-safe.
 */
export async function pullInvoicesForJob(
  organizationId: string,
  hcpJobId: string,
  fetchImpl?: typeof fetch,
): Promise<{ created: number; updated: number; skipped: number; failed: number }> {
  const summary = { created: 0, updated: 0, skipped: 0, failed: 0 };
  try {
    const client = await getHousecallClient(organizationId, fetchImpl);
    if (!client) return summary;
    const list = await client.listJobInvoices(hcpJobId);
    for (const inv of list) {
      let outcome: InvoicePullOutcome;
      try {
        outcome = await upsertHcpInvoiceRecord(organizationId, inv);
      } catch (error) {
        logger.warn(
          { error, hcpInvoiceId: inv.id },
          "HCP invoice pull failed for job invoice (degraded)",
        );
        outcome = "failed";
      }
      summary[outcome]++;
    }
  } catch (error) {
    logger.warn({ error, hcpJobId }, "HCP job-invoice pull failed (degraded)");
  }
  return summary;
}
