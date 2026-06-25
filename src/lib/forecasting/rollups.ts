/**
 * Nightly demand rollup → demand_daily (Probook v3, Phase 4). Buckets by the
 * BUSINESS timezone (not raw UTC) so late-evening-Eastern bookings land on the
 * correct day. The aggregation is a pure, unit-tested function; the DB glue is a
 * thin read + idempotent upsert (onConflictDoUpdate keyed by the unique index).
 *
 * Per-jobType rows carry that type's bookings; one '__all__' row per day carries
 * the day's total bookings + the session/booked funnel counts.
 */
import { count, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions, demandDaily, serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { BUSINESS_TIME_ZONE } from "@/lib/admin/calendar-time";

export const ALL_JOB_TYPES = "__all__";

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
