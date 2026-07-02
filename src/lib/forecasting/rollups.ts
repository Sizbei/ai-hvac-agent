/**
 * Nightly demand rollup → demand_daily (Probook v3, Phase 4). Buckets by the
 * BUSINESS timezone (not raw UTC) so late-evening-Eastern bookings land on the
 * correct day. The aggregation is a pure, unit-tested function; the DB glue is a
 * thin read + idempotent upsert (onConflictDoUpdate keyed by the unique index).
 *
 * Per-jobType rows carry that type's bookings; one '__all__' row per day carries
 * the day's total bookings + the session/booked funnel counts.
 */
import {
  and,
  count,
  eq,
  gte,
  isNotNull,
  isNull,
  inArray,
  or,
  sum,
  sql,
  type AnyColumn,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customerSessions,
  demandDaily,
  invoices,
  payments,
  refunds,
  revenueDaily,
  serviceRequests,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { BUSINESS_TIME_ZONE } from "@/lib/admin/calendar-time";

export const ALL_JOB_TYPES = "__all__";

// Revenue bases — NEVER blended (money-safety). native = payment-date basis;
// synced = creation-cohort, paid-to-date (synced invoices carry no payment date).
export const NATIVE_PAYMENT = "native_payment";
export const SYNCED_CREATION = "synced_creation";

export interface DemandBookingRow {
  readonly day: string; // business-TZ yyyy-mm-dd
  readonly jobType: string | null;
  readonly n: number | string; // neon-http count() may be a string
}
export interface DemandSessionRow {
  readonly day: string;
  readonly sessions: number | string;
  readonly booked: number | string;
}
export interface DemandDailyRow {
  readonly day: string;
  readonly jobType: string;
  readonly bookings: number;
  readonly sessions: number;
  readonly booked: number;
}

/**
 * PURE: fold raw per-(day,jobType) booking counts + per-day session counts into
 * the demand_daily rows to upsert. A null jobType contributes to the day total
 * only (no per-type row). One '__all__' row per day holds the total + sessions.
 */
export function buildDemandRows(
  bookings: readonly DemandBookingRow[],
  sessions: readonly DemandSessionRow[],
): DemandDailyRow[] {
  interface Acc {
    perType: Map<string, number>;
    total: number;
    sessions: number;
    booked: number;
  }
  const byDay = new Map<string, Acc>();
  const ensure = (day: string): Acc => {
    let e = byDay.get(day);
    if (!e) {
      e = { perType: new Map(), total: 0, sessions: 0, booked: 0 };
      byDay.set(day, e);
    }
    return e;
  };

  for (const b of bookings) {
    const e = ensure(b.day);
    const n = Number(b.n);
    e.total += n;
    if (b.jobType) e.perType.set(b.jobType, (e.perType.get(b.jobType) ?? 0) + n);
  }
  for (const s of sessions) {
    const e = ensure(s.day);
    e.sessions = Number(s.sessions);
    e.booked = Number(s.booked);
  }

  const rows: DemandDailyRow[] = [];
  for (const [day, e] of byDay) {
    rows.push({ day, jobType: ALL_JOB_TYPES, bookings: e.total, sessions: e.sessions, booked: e.booked });
    for (const [jobType, bookings] of e.perType) {
      rows.push({ day, jobType, bookings, sessions: 0, booked: 0 });
    }
  }
  return rows;
}

/** Refresh demand_daily for an org (optionally only days >= sinceDay). Idempotent. */
export async function refreshDemandDaily(
  organizationId: string,
  sinceDay?: string,
): Promise<void> {
  const since = sinceDay ? new Date(`${sinceDay}T00:00:00.000Z`) : null;
  // date(<ts> AT TIME ZONE tz) buckets in the business timezone, not UTC.
  const bookingDay = sql<string>`to_char(date(${serviceRequests.createdAt} AT TIME ZONE ${BUSINESS_TIME_ZONE}), 'YYYY-MM-DD')`;
  const sessionDay = sql<string>`to_char(date(${customerSessions.createdAt} AT TIME ZONE ${BUSINESS_TIME_ZONE}), 'YYYY-MM-DD')`;

  const [bookingRows, sessionRows] = await Promise.all([
    db
      .select({ day: bookingDay, jobType: serviceRequests.jobType, n: count() })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          ...(since ? [gte(serviceRequests.createdAt, since)] : []),
        ),
      )
      .groupBy(sql`date(${serviceRequests.createdAt} AT TIME ZONE ${BUSINESS_TIME_ZONE})`, serviceRequests.jobType),
    db
      .select({
        day: sessionDay,
        sessions: count(),
        booked: sql<number>`count(*) FILTER (WHERE ${customerSessions.outcome} = 'booked')`,
      })
      .from(customerSessions)
      .where(
        withTenant(
          customerSessions,
          organizationId,
          ...(since ? [gte(customerSessions.createdAt, since)] : []),
        ),
      )
      .groupBy(sql`date(${customerSessions.createdAt} AT TIME ZONE ${BUSINESS_TIME_ZONE})`),
  ]);

  const rows = buildDemandRows(bookingRows, sessionRows);
  // Idempotent per-row upsert keyed by (org, day, jobType). Each is independent —
  // a partial run self-heals next time (no cross-row atomicity assumed).
  for (const r of rows) {
    await db
      .insert(demandDaily)
      .values({
        organizationId,
        day: r.day,
        jobType: r.jobType,
        bookings: r.bookings,
        sessions: r.sessions,
        booked: r.booked,
      })
      .onConflictDoUpdate({
        target: [demandDaily.organizationId, demandDaily.day, demandDaily.jobType],
        set: { bookings: r.bookings, sessions: r.sessions, booked: r.booked },
      });
  }
}

export interface DayCentsRow {
  readonly day: string;
  readonly cents: number | string | null; // neon-http sum() → string | null
}
export interface RevenueDailyRow {
  readonly day: string;
  readonly basis: string;
  readonly collectedCents: number;
  readonly invoicedCents: number;
  readonly refundedCents: number;
}

/**
 * PURE: fold the five revenue queries into revenue_daily rows. Native and synced
 * are emitted as SEPARATE basis rows — a day with both produces two rows and they
 * are NEVER summed (money-safety). Synced has no native refunds (refunded = 0).
 */
export function buildRevenueRows(input: {
  readonly nativeCollected: readonly DayCentsRow[];
  readonly nativeRefunded: readonly DayCentsRow[];
  readonly nativeInvoiced: readonly DayCentsRow[];
  readonly syncedInvoiced: readonly DayCentsRow[];
  readonly syncedCollected: readonly DayCentsRow[];
}): RevenueDailyRow[] {
  const toMap = (rows: readonly DayCentsRow[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.day, Number(r.cents ?? 0));
    return m;
  };
  const nc = toMap(input.nativeCollected);
  const nr = toMap(input.nativeRefunded);
  const ni = toMap(input.nativeInvoiced);
  const si = toMap(input.syncedInvoiced);
  const sc = toMap(input.syncedCollected);

  const rows: RevenueDailyRow[] = [];
  for (const day of new Set([...nc.keys(), ...nr.keys(), ...ni.keys()])) {
    rows.push({
      day,
      basis: NATIVE_PAYMENT,
      collectedCents: nc.get(day) ?? 0,
      invoicedCents: ni.get(day) ?? 0,
      refundedCents: nr.get(day) ?? 0,
    });
  }
  for (const day of new Set([...si.keys(), ...sc.keys()])) {
    rows.push({
      day,
      basis: SYNCED_CREATION,
      collectedCents: sc.get(day) ?? 0,
      invoicedCents: si.get(day) ?? 0,
      refundedCents: 0,
    });
  }
  return rows;
}

/** Refresh revenue_daily for an org. Idempotent; native/synced kept separate. */
export async function refreshRevenueDaily(
  organizationId: string,
  sinceDay?: string,
): Promise<void> {
  const since = sinceDay ? new Date(`${sinceDay}T00:00:00.000Z`) : null;
  const day = (col: AnyColumn) =>
    sql<string>`to_char(date(${col} AT TIME ZONE ${BUSINESS_TIME_ZONE}), 'YYYY-MM-DD')`;
  const dayGroup = (col: AnyColumn) =>
    sql`date(${col} AT TIME ZONE ${BUSINESS_TIME_ZONE})`;
  const sinceFor = (col: AnyColumn) => (since ? [gte(col, since)] : []);
  const isSynced = or(
    isNotNull(invoices.fieldpulseInvoiceId),
    isNotNull(invoices.hcpInvoiceId),
  )!;
  const isNative = and(
    isNull(invoices.fieldpulseInvoiceId),
    isNull(invoices.hcpInvoiceId),
  )!;
  const billable = inArray(invoices.state, ["open", "paid"]);

  const [nativeCollected, nativeRefunded, nativeInvoiced, syncedInvoiced, syncedCollected] =
    await Promise.all([
      db
        .select({ day: day(payments.createdAt), cents: sum(payments.amountCents) })
        .from(payments)
        .where(
          withTenant(
            payments,
            organizationId,
            eq(payments.status, "succeeded"),
            ...sinceFor(payments.createdAt),
          ),
        )
        .groupBy(dayGroup(payments.createdAt)),
      db
        .select({ day: day(refunds.createdAt), cents: sum(refunds.amountCents) })
        .from(refunds)
        .where(withTenant(refunds, organizationId, ...sinceFor(refunds.createdAt)))
        .groupBy(dayGroup(refunds.createdAt)),
      db
        .select({ day: day(invoices.createdAt), cents: sum(invoices.totalCents) })
        .from(invoices)
        .where(
          withTenant(invoices, organizationId, isNative, billable, ...sinceFor(invoices.createdAt)),
        )
        .groupBy(dayGroup(invoices.createdAt)),
      db
        .select({ day: day(invoices.createdAt), cents: sum(invoices.totalCents) })
        .from(invoices)
        .where(
          withTenant(invoices, organizationId, isSynced, billable, ...sinceFor(invoices.createdAt)),
        )
        .groupBy(dayGroup(invoices.createdAt)),
      db
        .select({ day: day(invoices.createdAt), cents: sum(invoices.amountPaidCents) })
        .from(invoices)
        .where(
          withTenant(invoices, organizationId, isSynced, billable, ...sinceFor(invoices.createdAt)),
        )
        .groupBy(dayGroup(invoices.createdAt)),
    ]);

  const rows = buildRevenueRows({
    nativeCollected,
    nativeRefunded,
    nativeInvoiced,
    syncedInvoiced,
    syncedCollected,
  });
  for (const r of rows) {
    await db
      .insert(revenueDaily)
      .values({
        organizationId,
        day: r.day,
        basis: r.basis,
        collectedCents: r.collectedCents,
        invoicedCents: r.invoicedCents,
        refundedCents: r.refundedCents,
      })
      .onConflictDoUpdate({
        target: [revenueDaily.organizationId, revenueDaily.day, revenueDaily.basis],
        set: {
          collectedCents: r.collectedCents,
          invoicedCents: r.invoicedCents,
          refundedCents: r.refundedCents,
        },
      });
  }
}
