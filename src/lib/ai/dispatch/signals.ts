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
import { serviceRequests, reviewRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface DispatchJobAttrs {
  readonly jobType: string | null;
  readonly systemType: string | null;
}

/** The three raw signals the scorer consumes, per technician. */
export interface TechSignalRow {
  readonly skillJobsCompleted: number;
  readonly avgRating: number | null;
  readonly sameDayJobCount: number;
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
    result.set(id, { skillJobsCompleted: 0, avgRating: null, sameDayJobCount: 0 });
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

  const [skillRows, ratingRows, loadRows] = await Promise.all([
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
  return result;
}
