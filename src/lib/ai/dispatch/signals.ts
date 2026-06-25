import {
  and,
  eq,
  or,
  gte,
  lt,
  inArray,
  avg,
  count,
  isNotNull,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests, reviewRequests, estimates, invoices } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface DispatchJobAttrs {
  readonly jobType: string | null;
  readonly systemType: string | null;
}

/** The raw signals the scorer consumes, per technician. */
export interface TechSignalRow {
  readonly skillJobsCompleted: number;
  readonly avgRating: number | null;
  readonly sameDayJobCount: number;
  /** Sold estimates / total estimates on this tech's jobs, in [0,1] (0 when none). */
  readonly conversionRate: number;
  /** Avg invoice total (cents) on this tech's completed jobs (0 when none). */
  readonly avgJobRevenueCents: number;
}

// Open statuses that count toward a tech's same-day load (everything not
// terminal and already placed on a day).
const SAME_DAY_LOAD_STATUSES = [
  "assigned",
  "scheduled",
  "in_progress",
  "on_hold",
] as const;

type JobTypeValue = (typeof serviceRequests.jobType.enumValues)[number];
type SystemTypeValue = (typeof serviceRequests.systemType.enumValues)[number];

/**
 * Load dispatch signals for a set of technicians, scoped to one org.
 * Returns a Map keyed by technicianId; every requested tech is present (defaulted
 * to zeros / null) so the caller never has to null-check a missing tech.
 *
 * When the job has NO classification (both jobType and systemType null) there is
 * no skill signal to match on, so skillJobsCompleted stays 0 for everyone — the
 * scorer then matches nobody and the orchestrator degrades to the dispatcher.
 */
export async function loadDispatchSignals(
  organizationId: string,
  technicianIds: readonly string[],
  job: DispatchJobAttrs,
  isoDay: string,
): Promise<Map<string, TechSignalRow>> {
  const result = new Map<string, TechSignalRow>();
  for (const id of technicianIds) {
    result.set(id, {
      skillJobsCompleted: 0,
      avgRating: null,
      sameDayJobCount: 0,
      conversionRate: 0,
      avgJobRevenueCents: 0,
    });
  }
  if (technicianIds.length === 0) return result;

  const ids = [...technicianIds];
  const dayStart = new Date(`${isoDay}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  // Skill predicate from whichever classification fields are present.
  const skillMatchers = [];
  if (job.jobType)
    skillMatchers.push(eq(serviceRequests.jobType, job.jobType as JobTypeValue));
  if (job.systemType)
    skillMatchers.push(
      eq(serviceRequests.systemType, job.systemType as SystemTypeValue),
    );
  const skillPredicate =
    skillMatchers.length === 1
      ? skillMatchers[0]
      : skillMatchers.length > 1
        ? or(...skillMatchers)
        : null;

  const [skillRows, ratingRows, loadRows, conversionRows, revenueRows] = await Promise.all([
    skillPredicate
      ? db
          .select({ techId: serviceRequests.assignedTo, n: count() })
          .from(serviceRequests)
          .where(
            withTenant(
              serviceRequests,
              organizationId,
              and(
                inArray(serviceRequests.assignedTo, ids),
                eq(serviceRequests.status, "completed"),
                skillPredicate,
              )!,
            ),
          )
          .groupBy(serviceRequests.assignedTo)
      : Promise.resolve([] as { techId: string | null; n: number }[]),

    db
      .select({
        techId: serviceRequests.assignedTo,
        rating: avg(reviewRequests.rating),
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
          and(
            inArray(serviceRequests.assignedTo, ids),
            isNotNull(reviewRequests.rating),
          )!,
        ),
      )
      .groupBy(serviceRequests.assignedTo),

    db
      .select({ techId: serviceRequests.assignedTo, n: count() })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          and(
            inArray(serviceRequests.assignedTo, ids),
            inArray(serviceRequests.status, [...SAME_DAY_LOAD_STATUSES]),
            gte(serviceRequests.arrivalWindowStart, dayStart),
            lt(serviceRequests.arrivalWindowStart, dayEnd),
          )!,
        ),
      )
      .groupBy(serviceRequests.assignedTo),

    // Conversion: sold estimates / total estimates on each tech's jobs.
    db
      .select({
        techId: serviceRequests.assignedTo,
        total: count(),
        sold: sql<number>`count(*) FILTER (WHERE ${estimates.status} = 'sold')`,
      })
      .from(estimates)
      .innerJoin(
        serviceRequests,
        sql`${estimates.serviceRequestId} = ${serviceRequests.id} AND ${serviceRequests.organizationId} = ${organizationId}`,
      )
      .where(
        withTenant(estimates, organizationId, inArray(serviceRequests.assignedTo, ids)),
      )
      .groupBy(serviceRequests.assignedTo),

    // Avg job revenue: avg invoice total on each tech's completed jobs (native+synced,
    // excluding draft/void). Surfaced as a reason; not yet a weighted term.
    db
      .select({
        techId: serviceRequests.assignedTo,
        avgCents: avg(invoices.totalCents),
      })
      .from(invoices)
      .innerJoin(
        serviceRequests,
        sql`${invoices.serviceRequestId} = ${serviceRequests.id} AND ${serviceRequests.organizationId} = ${organizationId}`,
      )
      .where(
        withTenant(
          invoices,
          organizationId,
          and(
            inArray(serviceRequests.assignedTo, ids),
            eq(serviceRequests.status, "completed"),
            inArray(invoices.state, ["open", "paid"]),
          )!,
        ),
      )
      .groupBy(serviceRequests.assignedTo),
  ]);

  for (const r of skillRows) {
    if (r.techId && result.has(r.techId)) {
      result.set(r.techId, {
        ...result.get(r.techId)!,
        skillJobsCompleted: Number(r.n),
      });
    }
  }
  for (const r of ratingRows) {
    if (r.techId && result.has(r.techId)) {
      result.set(r.techId, {
        ...result.get(r.techId)!,
        avgRating: r.rating != null ? Number(r.rating) : null,
      });
    }
  }
  for (const r of loadRows) {
    if (r.techId && result.has(r.techId)) {
      result.set(r.techId, {
        ...result.get(r.techId)!,
        sameDayJobCount: Number(r.n),
      });
    }
  }
  for (const r of conversionRows) {
    if (r.techId && result.has(r.techId)) {
      const total = Number(r.total);
      const sold = Number(r.sold);
      result.set(r.techId, {
        ...result.get(r.techId)!,
        conversionRate: total > 0 ? sold / total : 0,
      });
    }
  }
  for (const r of revenueRows) {
    if (r.techId && result.has(r.techId)) {
      result.set(r.techId, {
        ...result.get(r.techId)!,
        avgJobRevenueCents: r.avgCents != null ? Math.round(Number(r.avgCents)) : 0,
      });
    }
  }
  return result;
}
