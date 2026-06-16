/**
 * Stage 10 — sales / revenue reporting.
 *
 * Read-only aggregates over the Stage 9 estimates / invoices / payments / refunds
 * tables. Every aggregate is tenant-scoped via withTenant — a cross-org SUM is a
 * tenant breach. Money stays integer cents throughout (the UI formats at the
 * presentation boundary).
 *
 * neon-http note: SQL aggregates (sum/count) come back as strings (or null for an
 * empty set), so each value is coerced with Number() and coalesced to 0.
 */
import { eq, gte, lte, sql, sum, count } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  estimates,
  invoices,
  payments,
  refunds,
  serviceRequests,
  leadSourceEnum,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface SalesReportPeriod {
  readonly fromDate?: Date;
  readonly toDate?: Date;
}

export interface SalesReport {
  readonly fromDate: string;
  readonly toDate: string;
  /** Succeeded payments in the period (gross, before refunds). */
  readonly grossCollectedCents: number;
  /** Refunds issued in the period. */
  readonly refundedCents: number;
  /** grossCollectedCents - refundedCents. */
  readonly netCollectedCents: number;
  /** Open balance across invoices in state 'open' ONLY (excludes draft/paid/void/refunded). */
  readonly outstandingArCents: number;
  readonly estimatesCreated: number;
  readonly estimatesSold: number;
  readonly estimatesOpen: number;
  readonly estimatesExpired: number;
  /** sold / (open + sold + expired) * 100, rounded to one decimal. 0 when no decided/open estimates. */
  readonly closeRatePct: number;
  readonly invoicesCreated: number;
  readonly invoicesPaid: number;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Compute an org's sales/revenue report for a period. Defaults to the last 30
 * days when no range is given. All money in integer cents.
 */
export async function getSalesReport(
  organizationId: string,
  period: SalesReportPeriod = {},
): Promise<SalesReport> {
  const now = new Date();
  const toDate = period.toDate ?? now;
  const fromDate = period.fromDate ?? new Date(toDate.getTime() - THIRTY_DAYS_MS);

  const [
    grossRow,
    refundRow,
    arRow,
    estimateRow,
    invoiceRow,
  ] = await Promise.all([
    // Gross collected: succeeded payments created within the period.
    db
      .select({ value: sum(payments.amountCents) })
      .from(payments)
      .where(
        withTenant(
          payments,
          organizationId,
          eq(payments.status, "succeeded"),
          gte(payments.createdAt, fromDate),
          lte(payments.createdAt, toDate),
        ),
      ),

    // Refunds issued within the period (net-collected subtracts these).
    db
      .select({ value: sum(refunds.amountCents) })
      .from(refunds)
      .where(
        withTenant(
          refunds,
          organizationId,
          gte(refunds.createdAt, fromDate),
          lte(refunds.createdAt, toDate),
        ),
      ),

    // Outstanding AR: balance of invoices in state 'open' ONLY. A partially-
    // refunded fully-paid invoice stays 'paid' (contributes 0); an invoice
    // reopened to 'open' contributes its (total - paid) balance. NOT period-
    // scoped — AR is a point-in-time snapshot of what is owed right now.
    db
      .select({
        value: sum(
          sql`${invoices.totalCents} - ${invoices.amountPaidCents}`,
        ),
      })
      .from(invoices)
      .where(withTenant(invoices, organizationId, eq(invoices.state, "open"))),

    // Estimate buckets in ONE pass, created within the period. Expiry is lazy
    // (expiresAt is only enforced at approval), so an 'open' estimate whose
    // expiresAt is in the past is bucketed as expired here, NOT open.
    db
      .select({
        created: count(),
        sold: count(sql`CASE WHEN ${estimates.status} = 'sold' THEN 1 END`),
        expired: count(
          sql`CASE WHEN ${estimates.status} = 'expired'
                    OR (${estimates.status} = 'open'
                        AND ${estimates.expiresAt} IS NOT NULL
                        AND ${estimates.expiresAt} < ${now})
                   THEN 1 END`,
        ),
        open: count(
          sql`CASE WHEN ${estimates.status} = 'open'
                    AND (${estimates.expiresAt} IS NULL
                         OR ${estimates.expiresAt} >= ${now})
                   THEN 1 END`,
        ),
      })
      .from(estimates)
      .where(
        withTenant(
          estimates,
          organizationId,
          gte(estimates.createdAt, fromDate),
          lte(estimates.createdAt, toDate),
        ),
      ),

    // Invoices created within the period + how many are paid.
    db
      .select({
        created: count(),
        paid: count(sql`CASE WHEN ${invoices.state} = 'paid' THEN 1 END`),
      })
      .from(invoices)
      .where(
        withTenant(
          invoices,
          organizationId,
          gte(invoices.createdAt, fromDate),
          lte(invoices.createdAt, toDate),
        ),
      ),
  ]);

  const grossCollectedCents = toNumber(grossRow[0]?.value);
  const refundedCents = toNumber(refundRow[0]?.value);
  const netCollectedCents = grossCollectedCents - refundedCents;
  const outstandingArCents = toNumber(arRow[0]?.value);

  const estimatesCreated = toNumber(estimateRow[0]?.created);
  const estimatesSold = toNumber(estimateRow[0]?.sold);
  const estimatesExpired = toNumber(estimateRow[0]?.expired);
  const estimatesOpen = toNumber(estimateRow[0]?.open);

  const closeDenominator = estimatesOpen + estimatesSold + estimatesExpired;
  const closeRatePct =
    closeDenominator > 0
      ? Math.round((estimatesSold / closeDenominator) * 1000) / 10
      : 0;

  const invoicesCreated = toNumber(invoiceRow[0]?.created);
  const invoicesPaid = toNumber(invoiceRow[0]?.paid);

  return {
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    grossCollectedCents,
    refundedCents,
    netCollectedCents,
    outstandingArCents,
    estimatesCreated,
    estimatesSold,
    estimatesOpen,
    estimatesExpired,
    closeRatePct,
    invoicesCreated,
    invoicesPaid,
  };
}

// ---------------------------------------------------------------------------
// Marketing lead-source attribution — revenue + close-rate rolled up by the
// lead source captured at intake (serviceRequests.leadSource).
//
// Attribution model: a lead is counted in the period it was CREATED. "booked"
// and "revenue" are attributed back to that same lead cohort (we scope the
// invoice/payment joins by the service request's createdAt, NOT the payment's
// createdAt), so a lead and the money it produced land in the same period —
// that is what "revenue by source for this period" means for marketing ROI.
//
// Tenant-scoping is doubled on every join: serviceRequests AND the joined
// invoices/payments/refunds are each filtered by organizationId, otherwise a
// cross-org invoice could be summed against this org's service request.
// ---------------------------------------------------------------------------

export interface LeadSourceRow {
  /** A leadSourceEnum value, or 'unknown' for rows with NULL leadSource. */
  readonly source: string;
  /** Service requests with this source, created in the period. */
  readonly leads: number;
  /** Of those, how many reached a booked state (have at least one invoice). */
  readonly booked: number;
  /** Succeeded payments minus refunds attributed to this source's requests. */
  readonly revenueCents: number;
  /** booked / leads * 100, rounded to one decimal. 0 when no leads. */
  readonly closeRatePct: number;
}

/** Bucket key for a possibly-NULL leadSource: NULL -> 'unknown'. */
const UNKNOWN_SOURCE = "unknown";

/**
 * Per-lead-source revenue + close-rate for a period. Defaults to the last 30
 * days. Returns ONE row per known leadSourceEnum value PLUS 'unknown', always —
 * a source with zero leads still appears (sorted left from the enum domain, not
 * inner-joined away). All money in integer cents.
 */
export async function getLeadSourceBreakdown(
  organizationId: string,
  period: SalesReportPeriod = {},
): Promise<LeadSourceRow[]> {
  const now = new Date();
  const toDate = period.toDate ?? now;
  const fromDate = period.fromDate ?? new Date(toDate.getTime() - THIRTY_DAYS_MS);

  // NULL leadSource -> 'unknown' so historical rows (column added later) still
  // reconcile into the totals instead of being dropped.
  const sourceKey = sql<string>`coalesce(${serviceRequests.leadSource}, ${UNKNOWN_SOURCE})`;

  const [leadRows, bookedRows, grossRows, refundRows] = await Promise.all([
    // 1. Leads: service requests by source, created in the period.
    db
      .select({ source: sourceKey, value: count() })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, fromDate),
          lte(serviceRequests.createdAt, toDate),
        ),
      )
      .groupBy(sourceKey),

    // 2. Booked: requests (in the period) that have at least one invoice. Count
    //    DISTINCT request ids so a request with multiple invoices counts once.
    //    BOTH sides tenant-scoped (the join predicate adds the invoice org).
    db
      .select({
        source: sourceKey,
        value: sql<number>`count(distinct ${serviceRequests.id})`,
      })
      .from(serviceRequests)
      .innerJoin(
        invoices,
        sql`${invoices.serviceRequestId} = ${serviceRequests.id} AND ${invoices.organizationId} = ${organizationId}`,
      )
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, fromDate),
          lte(serviceRequests.createdAt, toDate),
        ),
      )
      .groupBy(sourceKey),

    // 3. Gross revenue: succeeded payments on invoices of this source's requests
    //    (period-scoped by the REQUEST's createdAt — attribute money to the lead
    //    cohort). Summing payment rows directly avoids fan-out. All sides scoped.
    db
      .select({ source: sourceKey, value: sum(payments.amountCents) })
      .from(serviceRequests)
      .innerJoin(
        invoices,
        sql`${invoices.serviceRequestId} = ${serviceRequests.id} AND ${invoices.organizationId} = ${organizationId}`,
      )
      .innerJoin(
        payments,
        sql`${payments.invoiceId} = ${invoices.id} AND ${payments.organizationId} = ${organizationId} AND ${payments.status} = 'succeeded'`,
      )
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, fromDate),
          lte(serviceRequests.createdAt, toDate),
        ),
      )
      .groupBy(sourceKey),

    // 4. Refunds against those payments, subtracted in JS (kept a SEPARATE query
    //    so the payment x refund join doesn't fan out and double-count payments).
    db
      .select({ source: sourceKey, value: sum(refunds.amountCents) })
      .from(serviceRequests)
      .innerJoin(
        invoices,
        sql`${invoices.serviceRequestId} = ${serviceRequests.id} AND ${invoices.organizationId} = ${organizationId}`,
      )
      .innerJoin(
        payments,
        sql`${payments.invoiceId} = ${invoices.id} AND ${payments.organizationId} = ${organizationId}`,
      )
      .innerJoin(
        refunds,
        sql`${refunds.paymentId} = ${payments.id} AND ${refunds.organizationId} = ${organizationId}`,
      )
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, fromDate),
          lte(serviceRequests.createdAt, toDate),
        ),
      )
      .groupBy(sourceKey),
  ]);

  const leadsBySource = new Map<string, number>();
  for (const r of leadRows) leadsBySource.set(r.source, toNumber(r.value));
  const bookedBySource = new Map<string, number>();
  for (const r of bookedRows) bookedBySource.set(r.source, toNumber(r.value));
  const grossBySource = new Map<string, number>();
  for (const r of grossRows) grossBySource.set(r.source, toNumber(r.value));
  const refundBySource = new Map<string, number>();
  for (const r of refundRows) refundBySource.set(r.source, toNumber(r.value));

  // LEFT side from the enum DOMAIN + 'unknown' so zero-lead sources still render.
  const allSources = [...leadSourceEnum.enumValues, UNKNOWN_SOURCE];

  return allSources.map((source) => {
    const leads = leadsBySource.get(source) ?? 0;
    const booked = bookedBySource.get(source) ?? 0;
    const revenueCents =
      (grossBySource.get(source) ?? 0) - (refundBySource.get(source) ?? 0);
    const closeRatePct =
      leads > 0 ? Math.round((booked / leads) * 1000) / 10 : 0;
    return { source, leads, booked, revenueCents, closeRatePct };
  });
}
