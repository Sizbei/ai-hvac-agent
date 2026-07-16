/**
 * Operations metrics — owner daily-glance operational scorecard.
 *
 * Live SQL aggregation, mirroring getSalesReport: all sub-aggregates run
 * concurrently; each trend-bearing headline is computed for the selected window
 * AND the immediately-preceding equal-length window (that powers the delta
 * arrow). Every aggregate is tenant-scoped via withTenant.
 *
 * DESIGN NOTE: the duration metrics (response time, first response, time-to-paid)
 * fetch a small per-row set and reduce in JS rather than pushing median/avg into
 * SQL. Two reasons: median wants JS anyway, and it keeps every metric unit-
 * testable against the array-returning DB mock. At current scale (hundreds–low-
 * thousands of rows over a year) this is well within budget. If it ever slows,
 * the seam to precompute into demand_daily-style rollups is here.
 */
import { eq, gte, lt, isNull, isNotNull, or, sql, count } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  serviceRequests,
  requestStatusEvents,
  technicianTimeEntries,
  invoices,
  payments,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type {
  OperationsMetrics,
  MetricTrend,
  ArAging,
  SyncedArAging,
} from "./operations-metrics-types";

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

export interface OperationsMetricsPeriod {
  readonly fromDate?: Date;
  readonly toDate?: Date;
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function secondsBetween(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / 1000;
}

function median(nums: readonly number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function average(nums: readonly number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

/** Coerce a neon-http scalar (often a string) to a number, or 0. */
function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Coerce a neon-http scalar to a number, preserving null (no-data). */
function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type EventRow = {
  readonly firstAt: string | Date;
  readonly createdAt: string | Date;
};

/**
 * Split {anchorAt, createdAt} rows into current- and previous-window duration
 * lists (seconds). The anchor (when the thing happened — went in_progress, was
 * assigned, was paid) decides which window a row falls in. Negative spans
 * (clock skew / bad data) are dropped.
 */
function bucketDurations(
  rows: readonly EventRow[],
  fromDate: Date,
  toDate_: Date,
  prevFrom: Date,
): { current: number[]; previous: number[] } {
  const current: number[] = [];
  const previous: number[] = [];
  for (const row of rows) {
    const anchor = toDate(row.firstAt);
    const created = toDate(row.createdAt);
    const secs = secondsBetween(anchor, created);
    if (secs < 0) continue;
    if (anchor >= fromDate && anchor < toDate_) current.push(secs);
    else if (anchor >= prevFrom && anchor < fromDate) previous.push(secs);
  }
  return { current, previous };
}

export async function getOperationsMetrics(
  organizationId: string,
  period: OperationsMetricsPeriod = {},
): Promise<OperationsMetrics> {
  const now = new Date();
  const toDate_ = period.toDate ?? now;
  const fromDate = period.fromDate ?? new Date(toDate_.getTime() - THIRTY_DAYS_MS);
  const spanMs = Math.max(DAY_MS, toDate_.getTime() - fromDate.getTime());
  const prevFrom = new Date(fromDate.getTime() - spanMs);
  const rangeDays = Math.max(1, Math.round(spanMs / DAY_MS));

  const cut30 = new Date(now.getTime() - 30 * DAY_MS);
  const cut60 = new Date(now.getTime() - 60 * DAY_MS);
  // 1-day grace: align synced AR "current" boundary with the SummaryBand
  // overdue definition (dueDate < now - 1 day is overdue; not < now).
  const cut1day = new Date(now.getTime() - DAY_MS);

  const [
    inProgressRows,
    assignedRows,
    paidRows,
    onSiteRow,
    agingRow,
    syncedAgingRow,
    jobsCurrentRow,
    jobsPreviousRow,
    importedJobsCurrentRow,
  ] = await Promise.all([
    // Response time: first in_progress event per request across the two windows.
    db
      .select({
        firstAt: sql<string>`min(${requestStatusEvents.at})`,
        createdAt: serviceRequests.createdAt,
      })
      .from(requestStatusEvents)
      .innerJoin(
        serviceRequests,
        eq(serviceRequests.id, requestStatusEvents.serviceRequestId),
      )
      .where(
        // NO lower bound on `at`: min(at) must be the request's TRUE first
        // in_progress, not the first one inside the window. Bounding by prevFrom
        // would let a re-opened job's in-window transition masquerade as the
        // first response. The upper bound (< toDate_) is enough; bucketDurations
        // then keeps only the requests whose true-first falls in a window.
        // (Grows with history; the demand_daily-style rollup is the scale seam.)
        withTenant(
          requestStatusEvents,
          organizationId,
          eq(requestStatusEvents.toStatus, "in_progress"),
          lt(requestStatusEvents.at, toDate_),
        ),
      )
      .groupBy(requestStatusEvents.serviceRequestId, serviceRequests.createdAt),

    // First response: first assigned event per request PER actor (human/system).
    // serviceRequestId is carried so we can reduce to the EARLIEST-OVERALL
    // assignment per request in JS — a later reassignment (by either actor) must
    // not be mistaken for the first response. NO lower bound on `at` for the same
    // reason as above: we need the genuine first assignment, so an in-window
    // reassignment of a job first assigned long ago is correctly excluded.
    db
      .select({
        serviceRequestId: requestStatusEvents.serviceRequestId,
        actorType: requestStatusEvents.actorType,
        firstAt: sql<string>`min(${requestStatusEvents.at})`,
        createdAt: serviceRequests.createdAt,
      })
      .from(requestStatusEvents)
      .innerJoin(
        serviceRequests,
        eq(serviceRequests.id, requestStatusEvents.serviceRequestId),
      )
      .where(
        withTenant(
          requestStatusEvents,
          organizationId,
          eq(requestStatusEvents.toStatus, "assigned"),
          lt(requestStatusEvents.at, toDate_),
        ),
      )
      .groupBy(
        requestStatusEvents.serviceRequestId,
        requestStatusEvents.actorType,
        serviceRequests.createdAt,
      ),

    // Time to paid: native paid invoices + their paid-date (last succeeded pay).
    // Bounded to payments in [prevFrom, toDate_) so the fetch doesn't scan ALL
    // paid history on every load. Result-preserving: the paid-date is the MAX
    // succeeded payment, and JS keeps only paid-dates inside a window — an
    // invoice whose last payment predates prevFrom is out of window anyway, and
    // filtering earlier partial payments never changes an in-window max.
    db
      .select({
        firstAt: sql<string>`max(${payments.createdAt})`,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .innerJoin(payments, eq(payments.invoiceId, invoices.id))
      .where(
        withTenant(
          invoices,
          organizationId,
          eq(invoices.state, "paid"),
          isNull(invoices.fieldpulseInvoiceId),
          isNull(invoices.hcpInvoiceId),
          eq(payments.status, "succeeded"),
          gte(payments.createdAt, prevFrom),
          lt(payments.createdAt, toDate_),
        ),
      )
      .groupBy(invoices.id, invoices.createdAt),

    // On-site duration: avg minutes over closed time entries in the CURRENT window.
    db
      .select({
        avgMinutes: sql<string | null>`avg(${technicianTimeEntries.minutes})`,
      })
      .from(technicianTimeEntries)
      .where(
        withTenant(
          technicianTimeEntries,
          organizationId,
          isNotNull(technicianTimeEntries.minutes),
          gte(technicianTimeEntries.clockOutAt, fromDate),
          lt(technicianTimeEntries.clockOutAt, toDate_),
        ),
      ),

    // AR aging (NATIVE only): outstanding on open invoices as of now, bucketed
    // by invoice age. Synced FP/HCP invoices excluded — they are managed in
    // their own systems. Mirrors the timeToPaid native-only filter above.
    db
      .select({
        b0: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}) filter (where coalesce(${invoices.issuedAt}, ${invoices.createdAt}) >= ${cut30}), 0)`,
        b30: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}) filter (where coalesce(${invoices.issuedAt}, ${invoices.createdAt}) < ${cut30} and coalesce(${invoices.issuedAt}, ${invoices.createdAt}) >= ${cut60}), 0)`,
        b60: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}) filter (where coalesce(${invoices.issuedAt}, ${invoices.createdAt}) < ${cut60}), 0)`,
      })
      .from(invoices)
      .where(
        withTenant(
          invoices,
          organizationId,
          eq(invoices.state, "open"),
          isNull(invoices.fieldpulseInvoiceId),
          isNull(invoices.hcpInvoiceId),
          sql`${invoices.amountPaidCents} < ${invoices.totalCents}`,
        ),
      ),

    // AR aging (SYNCED): due-date-based buckets + the legacy total. Covers both
    // FP and HCP-synced open invoices — a HCP-synced invoice has hcpInvoiceId
    // set and must not be silently excluded. The bucket basis is
    // COALESCE(due_date, issued_at, created_at): mirrored invoices carry real
    // due dates (backfilled 2026-07-10), so "current" = not yet due and the
    // buckets are days PAST DUE; the rare row without a due date falls back to
    // its issue age (never "current").
    db
      .select({
        currentCents: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}) filter (where coalesce(${invoices.dueDate}, ${invoices.issuedAt}, ${invoices.createdAt}) >= ${cut1day}), 0)`,
        b0: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}) filter (where coalesce(${invoices.dueDate}, ${invoices.issuedAt}, ${invoices.createdAt}) < ${cut1day} and coalesce(${invoices.dueDate}, ${invoices.issuedAt}, ${invoices.createdAt}) >= ${cut30}), 0)`,
        b30: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}) filter (where coalesce(${invoices.dueDate}, ${invoices.issuedAt}, ${invoices.createdAt}) < ${cut30} and coalesce(${invoices.dueDate}, ${invoices.issuedAt}, ${invoices.createdAt}) >= ${cut60}), 0)`,
        b60: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}) filter (where coalesce(${invoices.dueDate}, ${invoices.issuedAt}, ${invoices.createdAt}) < ${cut60}), 0)`,
        totalCents: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}), 0)`,
        count: sql<string>`count(*)`,
      })
      .from(invoices)
      .where(
        withTenant(
          invoices,
          organizationId,
          eq(invoices.state, "open"),
          or(isNotNull(invoices.fieldpulseInvoiceId), isNotNull(invoices.hcpInvoiceId))!,
          sql`${invoices.amountPaidCents} < ${invoices.totalCents}`,
        ),
      ),

    // Jobs booked — current window (NATIVE only: FP/HCP-imported excluded).
    db
      .select({ value: count() })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          isNull(serviceRequests.fieldpulseJobId),
          isNull(serviceRequests.hcpJobId),
          gte(serviceRequests.createdAt, fromDate),
          lt(serviceRequests.createdAt, toDate_),
        ),
      ),

    // Jobs booked — previous window (NATIVE only).
    db
      .select({ value: count() })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          isNull(serviceRequests.fieldpulseJobId),
          isNull(serviceRequests.hcpJobId),
          gte(serviceRequests.createdAt, prevFrom),
          lt(serviceRequests.createdAt, fromDate),
        ),
      ),

    // Imported jobs booked — current window only (for the "+N imported" suffix).
    // Includes both FP-synced (fieldpulseJobId) and HCP-synced (hcpJobId) rows.
    db
      .select({ value: count() })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          or(isNotNull(serviceRequests.fieldpulseJobId), isNotNull(serviceRequests.hcpJobId))!,
          gte(serviceRequests.createdAt, fromDate),
          lt(serviceRequests.createdAt, toDate_),
        ),
      ),
  ]);

  // ── Reduce fetched rows into the headline trends ──
  const responseBuckets = bucketDurations(inProgressRows, fromDate, toDate_, prevFrom);
  const responseTimeSeconds: MetricTrend = {
    current: median(responseBuckets.current),
    previous: median(responseBuckets.previous),
  };

  // Reduce to the EARLIEST assigned event per request across actors. A request's
  // "first response" is whoever assigned it first; a later reassignment (by a
  // human OR the system) must not be counted — otherwise a dispatcher's override
  // of an already-auto-dispatched job would inflate the human headline.
  const firstAssignByRequest = new Map<string, (typeof assignedRows)[number]>();
  for (const row of assignedRows) {
    const prev = firstAssignByRequest.get(row.serviceRequestId);
    if (!prev || toDate(row.firstAt) < toDate(prev.firstAt)) {
      firstAssignByRequest.set(row.serviceRequestId, row);
    }
  }
  const firstAssignments = [...firstAssignByRequest.values()];

  const humanBuckets = bucketDurations(
    firstAssignments.filter((r) => r.actorType === "human"),
    fromDate,
    toDate_,
    prevFrom,
  );
  const firstResponseHumanSeconds: MetricTrend = {
    current: average(humanBuckets.current),
    previous: average(humanBuckets.previous),
  };
  const firstResponseSystemSeconds = average(
    bucketDurations(
      firstAssignments.filter((r) => r.actorType === "system"),
      fromDate,
      toDate_,
      prevFrom,
    ).current,
  );

  const paidBuckets = bucketDurations(paidRows, fromDate, toDate_, prevFrom);
  const timeToPaidSeconds: MetricTrend = {
    current: average(paidBuckets.current),
    previous: average(paidBuckets.previous),
  };

  const avgMinutes = toNumberOrNull(onSiteRow[0]?.avgMinutes);
  const onSiteSeconds = avgMinutes === null ? null : avgMinutes * 60;

  const b0 = toNumber(agingRow[0]?.b0);
  const b30 = toNumber(agingRow[0]?.b30);
  const b60 = toNumber(agingRow[0]?.b60);
  const arAging: ArAging = {
    bucket0to30Cents: b0,
    bucket31to60Cents: b30,
    bucket60PlusCents: b60,
    nativeOutstandingCents: b0 + b30 + b60,
  };

  const syncedArTotalCents = toNumber(syncedAgingRow[0]?.totalCents);
  const syncedArCount = toNumber(syncedAgingRow[0]?.count);
  const syncedArAging: SyncedArAging = {
    currentCents: toNumber(syncedAgingRow[0]?.currentCents),
    overdue1to30Cents: toNumber(syncedAgingRow[0]?.b0),
    overdue31to60Cents: toNumber(syncedAgingRow[0]?.b30),
    overdue60PlusCents: toNumber(syncedAgingRow[0]?.b60),
    totalOutstandingCents: syncedArTotalCents,
  };

  const jobsBooked: MetricTrend = {
    current: toNumber(jobsCurrentRow[0]?.value),
    previous: toNumber(jobsPreviousRow[0]?.value),
  };

  const importedJobsCurrent = toNumber(importedJobsCurrentRow[0]?.value);

  const totalOutstandingAllCents = (b0 + b30 + b60) + syncedArTotalCents; // native buckets + synced total

  return {
    rangeDays,
    responseTimeSeconds,
    onSiteSeconds,
    timeToPaidSeconds,
    arAging,
    syncedArTotalCents,
    syncedArCount,
    syncedArAging,
    totalOutstandingAllCents,
    jobsBooked,
    importedJobsCurrent,
    firstResponseHumanSeconds,
    firstResponseSystemSeconds,
  };
}
