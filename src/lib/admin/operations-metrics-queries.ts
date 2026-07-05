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
import { eq, gte, lt, isNull, isNotNull, sql, count } from "drizzle-orm";
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

  const [
    inProgressRows,
    assignedRows,
    paidRows,
    onSiteRow,
    agingRow,
    jobsCurrentRow,
    jobsPreviousRow,
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
        withTenant(
          requestStatusEvents,
          organizationId,
          eq(requestStatusEvents.toStatus, "in_progress"),
          gte(requestStatusEvents.at, prevFrom),
          lt(requestStatusEvents.at, toDate_),
        ),
      )
      .groupBy(requestStatusEvents.serviceRequestId, serviceRequests.createdAt),

    // First response: first assigned event per request PER actor (human/system).
    // serviceRequestId is carried so we can reduce to the EARLIEST-OVERALL
    // assignment per request in JS — a later reassignment (by either actor) must
    // not be mistaken for the first response.
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
          gte(requestStatusEvents.at, prevFrom),
          lt(requestStatusEvents.at, toDate_),
        ),
      )
      .groupBy(
        requestStatusEvents.serviceRequestId,
        requestStatusEvents.actorType,
        serviceRequests.createdAt,
      ),

    // Time to paid: native paid invoices + their paid-date (last succeeded pay).
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

    // AR aging: outstanding on OPEN invoices as of now, bucketed by invoice age.
    db
      .select({
        b0: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}) filter (where ${invoices.createdAt} >= ${cut30}), 0)`,
        b30: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}) filter (where ${invoices.createdAt} < ${cut30} and ${invoices.createdAt} >= ${cut60}), 0)`,
        b60: sql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}) filter (where ${invoices.createdAt} < ${cut60}), 0)`,
      })
      .from(invoices)
      .where(
        withTenant(
          invoices,
          organizationId,
          eq(invoices.state, "open"),
          sql`${invoices.amountPaidCents} < ${invoices.totalCents}`,
        ),
      ),

    // Jobs booked — current window.
    db
      .select({ value: count() })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, fromDate),
          lt(serviceRequests.createdAt, toDate_),
        ),
      ),

    // Jobs booked — previous window.
    db
      .select({ value: count() })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, prevFrom),
          lt(serviceRequests.createdAt, fromDate),
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
    totalOutstandingCents: b0 + b30 + b60,
  };

  const jobsBooked: MetricTrend = {
    current: toNumber(jobsCurrentRow[0]?.value),
    previous: toNumber(jobsPreviousRow[0]?.value),
  };

  return {
    rangeDays,
    responseTimeSeconds,
    onSiteSeconds,
    timeToPaidSeconds,
    arAging,
    jobsBooked,
    firstResponseHumanSeconds,
    firstResponseSystemSeconds,
  };
}
