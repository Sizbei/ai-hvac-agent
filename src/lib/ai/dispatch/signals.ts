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
import {
  serviceRequests,
  reviewRequests,
  estimates,
  invoices,
  customerLocations,
  users,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { haversineKm } from "@/lib/address/photon";
import { getLatestTechnicianLocation } from "@/lib/tech/location-queries";

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
  /** Straight-line km from the tech's anchor (latest live fix, else home base) to
   * the job's cached coordinates, or null when either coordinate is unknown.
   * Null → the scorer's travel term stays dormant and scoring is byte-identical
   * to the no-travel composite. */
  readonly travelKm: number | null;
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
  requestId?: string,
): Promise<Map<string, TechSignalRow>> {
  const result = new Map<string, TechSignalRow>();
  for (const id of technicianIds) {
    result.set(id, {
      skillJobsCompleted: 0,
      avgRating: null,
      sameDayJobCount: 0,
      conversionRate: 0,
      avgJobRevenueCents: 0,
      travelKm: null,
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

  // Travel term (dormant until here). Only when a requestId is supplied AND the
  // request has cached job coordinates does travelKm become non-null; otherwise
  // every travelKm stays null and the scorer is byte-identical to the composite.
  if (requestId) {
    const travelByTech = await loadTravelKm(organizationId, requestId, technicianIds);
    for (const [id, km] of travelByTech) {
      if (km != null && result.has(id)) {
        result.set(id, { ...result.get(id)!, travelKm: km });
      }
    }
  }

  return result;
}

/**
 * Straight-line km from each tech's anchor to the job's cached coordinates.
 * Returns null for a tech when either the job or that tech's anchor coordinate
 * is unknown — the scorer then treats travel as dormant for that tech. When the
 * job itself has no cached location, no per-tech anchor read is issued at all.
 */
async function loadTravelKm(
  organizationId: string,
  requestId: string,
  technicianIds: readonly string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>(
    technicianIds.map((id) => [id, null]),
  );
  const jobCoords = await loadJobCoords(organizationId, requestId);
  if (!jobCoords) return out;

  const anchors = await loadTechAnchors(organizationId, technicianIds);
  for (const id of technicianIds) {
    const a = anchors.get(id);
    if (a) {
      out.set(id, haversineKm(a.lat, a.lon, jobCoords.lat, jobCoords.lon));
    }
  }
  return out;
}

/** The job's cached coordinates via its linked customer_locations row, or null
 * when the request has no linked location (or the location has no coords). */
async function loadJobCoords(
  organizationId: string,
  requestId: string,
): Promise<{ readonly lat: number; readonly lon: number } | null> {
  const [row] = await db
    .select({
      lat: customerLocations.latitude,
      lon: customerLocations.longitude,
    })
    .from(serviceRequests)
    .innerJoin(
      customerLocations,
      sql`${customerLocations.id} = ${serviceRequests.locationId} AND ${customerLocations.organizationId} = ${organizationId}`,
    )
    .where(
      withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)),
    )
    .limit(1);
  if (!row || row.lat == null || row.lon == null) return null;
  return { lat: row.lat, lon: row.lon };
}

/** Anchor coordinate per tech: latest live GPS fix (consent-gated) preferred,
 * else the configured home base. Null when neither is available. */
async function loadTechAnchors(
  organizationId: string,
  technicianIds: readonly string[],
): Promise<Map<string, { readonly lat: number; readonly lon: number } | null>> {
  const anchors = new Map<
    string,
    { readonly lat: number; readonly lon: number } | null
  >();

  // Home-base fallback for all techs in one read.
  const homeRows = await db
    .select({
      id: users.id,
      lat: users.homeBaseLat,
      lon: users.homeBaseLng,
    })
    .from(users)
    .where(withTenant(users, organizationId, inArray(users.id, [...technicianIds])));
  const home = new Map(homeRows.map((r) => [r.id, r]));

  // Latest live fix preferred (reuses the consent-gated per-tech helper).
  const fixes = await Promise.all(
    technicianIds.map(
      async (id) =>
        [id, await getLatestTechnicianLocation(organizationId, id)] as const,
    ),
  );

  for (const [id, fix] of fixes) {
    if (fix) {
      anchors.set(id, { lat: fix.latitude, lon: fix.longitude });
      continue;
    }
    const h = home.get(id);
    anchors.set(
      id,
      h && h.lat != null && h.lon != null ? { lat: h.lat, lon: h.lon } : null,
    );
  }
  return anchors;
}
