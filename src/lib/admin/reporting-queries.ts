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
import { eq, gte, lte, sql, sum, count, avg, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  estimates,
  invoices,
  payments,
  refunds,
  serviceRequests,
  leadSourceEnum,
  customerLocations,
  technicianTimeEntries,
  reviewRequests,
  users,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface SalesReportPeriod {
  readonly fromDate?: Date;
  readonly toDate?: Date;
}

export interface SalesReport {
  readonly fromDate: string;
  readonly toDate: string;
  /** NATIVE succeeded payments in the period (gross, before refunds). Synced
   * (FSM-mirrored) invoices never have native payment rows, so this is native
   * money only — see syncedCollectedCents for the synced side. */
  readonly grossCollectedCents: number;
  /** Refunds issued in the period (native; synced invoices have no native refunds). */
  readonly refundedCents: number;
  /** grossCollectedCents - refundedCents (native net). */
  readonly netCollectedCents: number;
  /** SYNCED revenue: paid-to-date (as reported by the FSM) on FSM-synced invoices
   * CREATED in the period. Reported SEPARATELY from native so the two sources are
   * never blended into one double-counted total (a synced invoice has no native
   * payment rows, so it would otherwise be invisible in collected revenue).
   * BASIS CAVEAT: this is a creation-cohort, paid-to-date figure — NOT a
   * payment-date sum like native grossCollectedCents. Synced invoices carry no
   * per-payment dates, so it cannot be payment-date-scoped; treat the two bases
   * as related but not identical (don't naively add them as one "collected"). */
  readonly syncedCollectedCents: number;
  /** Open balance across ALL invoices in state 'open' (= nativeArCents + syncedArCents). */
  readonly outstandingArCents: number;
  /** Open balance on NATIVE invoices only (no FSM source id). */
  readonly nativeArCents: number;
  /** Open balance on FSM-synced invoices only. Split out so a request that has
   * BOTH a native and a synced invoice contributes to each bucket once, never a
   * blended double-count. */
  readonly syncedArCents: number;
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
    syncedCollectedRow,
  ] = await Promise.all([
    // Gross collected: payments that actually cleared. A FULLY-refunded payment
    // flips status to 'refunded' — it was still collected (the refund is
    // subtracted separately below), so it must stay in gross. Excluding it while
    // still subtracting its refund double-reduced net collected.
    db
      .select({ value: sum(payments.amountCents) })
      .from(payments)
      .where(
        withTenant(
          payments,
          organizationId,
          inArray(payments.status, ["succeeded", "refunded"]),
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
        // Split the open-AR balance by source via CASE so native and synced
        // money are never blended: each open invoice lands in exactly ONE bucket
        // (native = no FSM id; synced = a FieldPulse OR Housecall id), so a
        // request with both contributes to each once, never double-counted.
        native: sum(
          sql`CASE WHEN ${invoices.fieldpulseInvoiceId} IS NULL AND ${invoices.hcpInvoiceId} IS NULL THEN ${invoices.totalCents} - ${invoices.amountPaidCents} ELSE 0 END`,
        ),
        synced: sum(
          sql`CASE WHEN ${invoices.fieldpulseInvoiceId} IS NOT NULL OR ${invoices.hcpInvoiceId} IS NOT NULL THEN ${invoices.totalCents} - ${invoices.amountPaidCents} ELSE 0 END`,
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

    // Synced collected revenue: amount paid on FSM-synced invoices created in the
    // period. Synced invoices mirror FSM billing and carry no native payment
    // rows, so without this they'd be invisible in collected revenue. Kept as its
    // OWN figure (never folded into grossCollectedCents) so native + synced are
    // never blended into a double-counted total.
    db
      .select({ value: sum(invoices.amountPaidCents) })
      .from(invoices)
      .where(
        withTenant(
          invoices,
          organizationId,
          sql`(${invoices.fieldpulseInvoiceId} IS NOT NULL OR ${invoices.hcpInvoiceId} IS NOT NULL)`,
          gte(invoices.createdAt, fromDate),
          lte(invoices.createdAt, toDate),
        ),
      ),
  ]);

  const grossCollectedCents = toNumber(grossRow[0]?.value);
  const refundedCents = toNumber(refundRow[0]?.value);
  const netCollectedCents = grossCollectedCents - refundedCents;
  const syncedCollectedCents = toNumber(syncedCollectedRow[0]?.value);
  const nativeArCents = toNumber(arRow[0]?.native);
  const syncedArCents = toNumber(arRow[0]?.synced);
  const outstandingArCents = nativeArCents + syncedArCents;

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
    syncedCollectedCents,
    outstandingArCents,
    nativeArCents,
    syncedArCents,
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
        sql`${invoices.serviceRequestId} = ${serviceRequests.id} AND ${invoices.organizationId} = ${organizationId} AND ${invoices.state} NOT IN ('draft', 'void')`,
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

// ---------------------------------------------------------------------------
// Multi-location rollup — jobs + revenue (+ avg rating) per service location
// (customerLocations), with a synthetic "unassigned" bucket for service
// requests whose locationId is NULL.
//
// Cohort: a job is counted in the location bucket of the request created within
// the period (period-scoped by serviceRequests.createdAt, like lead-source).
// Revenue is the SUM of the job's invoice totals (totalCents) — "billed on
// their jobs" — summed off invoice rows directly (no payment fan-out). Rating
// is the avg of any review_requests rating on the job (NULL when none captured).
//
// TENANT SAFETY: serviceRequests is withTenant-scoped AND every joined table
// (invoices, review_requests, customer_locations) carries its OWN organizationId
// predicate in the join, so a cross-org invoice/review/location can never be
// summed against this org's requests. locationId has no FK, so the join to
// customer_locations is a LEFT join guarded by org on BOTH sides.
// ---------------------------------------------------------------------------

export interface LocationBreakdownRow {
  /** customerLocations.id, or the synthetic UNASSIGNED_LOCATION key. */
  readonly locationId: string;
  /** Location label/zone, or "Unassigned" for the NULL-location bucket. */
  readonly label: string;
  /** Service requests in this location bucket, created in the period. */
  readonly jobs: number;
  /** Sum of invoice totals on those jobs. Integer cents. */
  readonly revenueCents: number;
  /** Avg review rating (1-5) on those jobs, or null when none captured. */
  readonly avgRating: number | null;
}

/** Bucket key for requests with a NULL locationId. */
const UNASSIGNED_LOCATION = "unassigned";

/**
 * Per-location jobs + revenue (+ avg rating) for a period. Defaults to the last
 * 30 days. Returns one row per location that had jobs in the period PLUS an
 * "unassigned" bucket whenever any request had a NULL locationId. Money in cents.
 */
export async function getLocationBreakdown(
  organizationId: string,
  period: SalesReportPeriod = {},
): Promise<LocationBreakdownRow[]> {
  const now = new Date();
  const toDate = period.toDate ?? now;
  const fromDate = period.fromDate ?? new Date(toDate.getTime() - THIRTY_DAYS_MS);

  // NULL locationId -> 'unassigned' so requests without a site still reconcile.
  const locationKey = sql<string>`coalesce(cast(${serviceRequests.locationId} as text), ${UNASSIGNED_LOCATION})`;

  const [jobRows, revenueRows, ratingRows, labelRows] = await Promise.all([
    // 1. Jobs: service requests per location bucket, created in the period.
    db
      .select({ locationId: locationKey, value: count() })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, fromDate),
          lte(serviceRequests.createdAt, toDate),
        ),
      )
      .groupBy(locationKey),

    // 2. Revenue: sum invoice totals on those requests' invoices. BOTH sides
    //    org-scoped (the join predicate adds the invoice org).
    //    SOURCE NOTE: this is BILLED revenue across BOTH native and synced
    //    invoices (each invoice row summed ONCE — no fan-out), so a synced org's
    //    FSM billing IS included here. The data has no native↔synced "same-bill"
    //    linkage, so the rare request that has BOTH (a migration anomaly) counts
    //    both; getSalesReport holds the authoritative native/synced split.
    db
      .select({ locationId: locationKey, value: sum(invoices.totalCents) })
      .from(serviceRequests)
      .innerJoin(
        invoices,
        sql`${invoices.serviceRequestId} = ${serviceRequests.id} AND ${invoices.organizationId} = ${organizationId} AND ${invoices.state} NOT IN ('draft', 'void')`,
      )
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, fromDate),
          lte(serviceRequests.createdAt, toDate),
        ),
      )
      .groupBy(locationKey),

    // 3. Avg rating: review_requests rating on those requests (rating may be
    //    NULL for un-responded asks; avg ignores NULLs). BOTH sides org-scoped.
    db
      .select({ locationId: locationKey, value: avg(reviewRequests.rating) })
      .from(serviceRequests)
      .innerJoin(
        reviewRequests,
        sql`${reviewRequests.serviceRequestId} = ${serviceRequests.id} AND ${reviewRequests.organizationId} = ${organizationId}`,
      )
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, fromDate),
          lte(serviceRequests.createdAt, toDate),
        ),
      )
      .groupBy(locationKey),

    // 4. Labels: the location's label/zone. Org-scoped (the location's own org).
    db
      .select({
        id: customerLocations.id,
        label: customerLocations.label,
        zone: customerLocations.zone,
      })
      .from(customerLocations)
      .where(withTenant(customerLocations, organizationId)),
  ]);

  const jobsByLoc = new Map<string, number>();
  for (const r of jobRows) jobsByLoc.set(r.locationId, toNumber(r.value));
  const revenueByLoc = new Map<string, number>();
  for (const r of revenueRows) revenueByLoc.set(r.locationId, toNumber(r.value));
  const ratingByLoc = new Map<string, number | null>();
  for (const r of ratingRows) {
    // avg() returns null for an all-NULL/empty group; keep it null (honest "—").
    ratingByLoc.set(
      r.locationId,
      r.value == null ? null : Math.round(Number(r.value) * 10) / 10,
    );
  }
  const labelById = new Map<string, string>();
  for (const r of labelRows) {
    labelById.set(r.id, r.label ?? r.zone ?? "Location");
  }

  // One row per location bucket that had jobs in the period (the LEFT side is
  // the set of buckets that actually appeared, not the full location catalog).
  return [...jobsByLoc.keys()]
    .map((locationId) => ({
      locationId,
      label:
        locationId === UNASSIGNED_LOCATION
          ? "Unassigned"
          : (labelById.get(locationId) ?? "Location"),
      jobs: jobsByLoc.get(locationId) ?? 0,
      revenueCents: revenueByLoc.get(locationId) ?? 0,
      avgRating: ratingByLoc.get(locationId) ?? null,
    }))
    .sort((a, b) => b.revenueCents - a.revenueCents);
}

// ---------------------------------------------------------------------------
// Per-technician scorecards — one row per technician (user) with at least one
// assigned job in the period.
//
// Cohort: jobs assigned to the tech (serviceRequests.assignedTo), created in the
// period. jobsCompleted counts those in status 'completed'. revenueCents sums
// invoice totals on the tech's jobs. laborHours sums technician_time_entries
// minutes (the tech's OWN entries) / 60. avgRating averages review_requests
// ratings on the tech's jobs.
//
// HONEST DATA: laborHours is NULL (renders "—") when the tech has NO time
// entries at all in the period — a fake 0h would imply "worked zero hours",
// which is misleading when time tracking simply isn't being used. avgRating is
// NULL when no review captured a rating. onTimeRate is OMITTED entirely: the
// schema records an arrival WINDOW (arrivalWindowStart/End) but never an ACTUAL
// arrival timestamp, so on-time cannot be derived without inventing data.
//
// TENANT SAFETY: serviceRequests is withTenant-scoped AND every joined table
// (users, invoices, technician_time_entries, review_requests) carries its OWN
// organizationId predicate, so no cross-org row can be aggregated against this
// org's technician.
// ---------------------------------------------------------------------------

export interface TechnicianScorecardRow {
  readonly technicianId: string;
  readonly name: string;
  /** Jobs assigned to this tech, created in the period. */
  readonly jobsAssigned: number;
  /** Of those, how many reached status 'completed'. */
  readonly jobsCompleted: number;
  /** Sum of invoice totals on this tech's jobs. Integer cents. */
  readonly revenueCents: number;
  /** Labor hours from this tech's time entries (1dp), or null when none logged. */
  readonly laborHours: number | null;
  /** Avg review rating (1-5) on this tech's jobs, or null when none captured. */
  readonly avgRating: number | null;
}

/**
 * Per-technician scorecards for a period. Defaults to the last 30 days. Returns
 * one row per technician with at least one assigned job in the period. Metrics
 * that aren't computable from captured data are returned as null (the UI renders
 * "—"), never a misleading 0. Money in integer cents.
 */
export async function getTechnicianScorecards(
  organizationId: string,
  period: SalesReportPeriod = {},
): Promise<TechnicianScorecardRow[]> {
  const now = new Date();
  const toDate = period.toDate ?? now;
  const fromDate = period.fromDate ?? new Date(toDate.getTime() - THIRTY_DAYS_MS);

  const [jobRows, revenueRows, laborRows, ratingRows] = await Promise.all([
    // 1. Jobs assigned + completed per tech, plus the tech's name. INNER join to
    //    users (assignedTo must resolve to a real user) — org-scoped on BOTH
    //    sides. Requests with a NULL assignedTo are dropped (no tech to score).
    db
      .select({
        technicianId: serviceRequests.assignedTo,
        name: users.name,
        assigned: count(),
        completed: count(
          sql`CASE WHEN ${serviceRequests.status} = 'completed' THEN 1 END`,
        ),
      })
      .from(serviceRequests)
      .innerJoin(
        users,
        sql`${users.id} = ${serviceRequests.assignedTo} AND ${users.organizationId} = ${organizationId}`,
      )
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, fromDate),
          lte(serviceRequests.createdAt, toDate),
        ),
      )
      .groupBy(serviceRequests.assignedTo, users.name),

    // 2. Revenue: invoice totals on the tech's jobs. ALL sides org-scoped.
    //    SOURCE NOTE: billed revenue across BOTH native and synced invoices (each
    //    summed once — no fan-out); see getLocationBreakdown. getSalesReport holds
    //    the authoritative native/synced split.
    db
      .select({
        technicianId: serviceRequests.assignedTo,
        value: sum(invoices.totalCents),
      })
      .from(serviceRequests)
      .innerJoin(
        invoices,
        sql`${invoices.serviceRequestId} = ${serviceRequests.id} AND ${invoices.organizationId} = ${organizationId} AND ${invoices.state} NOT IN ('draft', 'void')`,
      )
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, fromDate),
          lte(serviceRequests.createdAt, toDate),
        ),
      )
      .groupBy(serviceRequests.assignedTo),

    // 3. Labor minutes: the tech's OWN time entries on jobs created in the
    //    period. Scoped by the entry's technicianId (the person who logged the
    //    time), the request cohort, and org on BOTH the entry and the request.
    db
      .select({
        technicianId: technicianTimeEntries.technicianId,
        value: sum(technicianTimeEntries.minutes),
      })
      .from(technicianTimeEntries)
      .innerJoin(
        serviceRequests,
        sql`${serviceRequests.id} = ${technicianTimeEntries.serviceRequestId} AND ${serviceRequests.organizationId} = ${organizationId} AND ${serviceRequests.createdAt} >= ${fromDate} AND ${serviceRequests.createdAt} <= ${toDate}`,
      )
      .where(withTenant(technicianTimeEntries, organizationId))
      .groupBy(technicianTimeEntries.technicianId),

    // 4. Avg rating on the tech's jobs. ALL sides org-scoped.
    db
      .select({
        technicianId: serviceRequests.assignedTo,
        value: avg(reviewRequests.rating),
      })
      .from(serviceRequests)
      .innerJoin(
        reviewRequests,
        sql`${reviewRequests.serviceRequestId} = ${serviceRequests.id} AND ${reviewRequests.organizationId} = ${organizationId}`,
      )
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, fromDate),
          lte(serviceRequests.createdAt, toDate),
        ),
      )
      .groupBy(serviceRequests.assignedTo),
  ]);

  const revenueByTech = new Map<string, number>();
  for (const r of revenueRows) {
    if (r.technicianId) revenueByTech.set(r.technicianId, toNumber(r.value));
  }
  // Map of tech -> minutes. ABSENCE means "no time entries" -> null laborHours
  // (an honest "—"); presence with 0 minutes would still be a real 0.
  const minutesByTech = new Map<string, number>();
  for (const r of laborRows) {
    if (r.technicianId) minutesByTech.set(r.technicianId, toNumber(r.value));
  }
  const ratingByTech = new Map<string, number | null>();
  for (const r of ratingRows) {
    if (!r.technicianId) continue;
    ratingByTech.set(
      r.technicianId,
      r.value == null ? null : Math.round(Number(r.value) * 10) / 10,
    );
  }

  return jobRows
    .filter((r): r is typeof r & { technicianId: string } => r.technicianId != null)
    .map((r) => {
      const technicianId = r.technicianId;
      const hasLabor = minutesByTech.has(technicianId);
      const laborHours = hasLabor
        ? Math.round((minutesByTech.get(technicianId)! / 60) * 10) / 10
        : null;
      return {
        technicianId,
        name: r.name,
        jobsAssigned: toNumber(r.assigned),
        jobsCompleted: toNumber(r.completed),
        revenueCents: revenueByTech.get(technicianId) ?? 0,
        laborHours,
        avgRating: ratingByTech.get(technicianId) ?? null,
      };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents);
}
