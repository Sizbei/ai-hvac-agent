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
import { getLatestTechnicianLocations } from "@/lib/tech/location-queries";
import { durationMatrix, routingEnabled } from "./travel";
import { businessWallClockToUtc } from "@/lib/admin/calendar-time";

/**
 * UTC [start, end) covering the business-timezone (Eastern) calendar day for
 * `isoDay`. `isoDay` is produced in business-local time, so anchoring the range
 * with businessWallClockToUtc keeps late-evening Eastern jobs on the correct day
 * (a naive `${isoDay}T00:00Z` would shift the window ~4-5h and miscount them).
 */
export function businessDayUtcRange(isoDay: string): {
  readonly start: Date;
  readonly end: Date;
} {
  return {
    start: businessWallClockToUtc(isoDay, 0, 0),
    // hour=24 rolls Date.UTC to midnight of isoDay+1 (JS date normalization),
    // which businessWallClockToUtc then offset-corrects in the NEXT day's zone —
    // exactly right across DST transitions (23h/25h business days).
    end: businessWallClockToUtc(isoDay, 24, 0),
  };
}

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
  /** Road drive-time (minutes) from the tech's anchor to the job via the
   * configured routing provider, or null when routing is off / the call failed /
   * that origin couldn't be priced. Preferred over travelKm by the scorer; null →
   * fall back to the straight-line term. */
  readonly travelMinutes: number | null;
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
      travelMinutes: null,
    });
  }
  if (technicianIds.length === 0) return result;

  const ids = [...technicianIds];
  const { start: dayStart, end: dayEnd } = businessDayUtcRange(isoDay);

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
  // request has cached job coordinates does travel become non-null; otherwise
  // every travel field stays null and the scorer is byte-identical to the composite.
  if (requestId) {
    const travelByTech = await loadTravelSignals(organizationId, requestId, technicianIds);
    for (const [id, t] of travelByTech) {
      if (result.has(id) && (t.km != null || t.minutes != null)) {
        result.set(id, {
          ...result.get(id)!,
          travelKm: t.km,
          travelMinutes: t.minutes,
        });
      }
    }
  }

  return result;
}

/**
 * Travel signal per tech: always the straight-line `km` from the tech's anchor to
 * the job's cached coordinates (null when either is unknown), plus optional road
 * drive `minutes` from the configured routing provider as an overlay. The scorer
 * prefers minutes and falls back to km, so routing is a strict best-effort
 * improvement: when it's off or a tech can't be priced, behavior is unchanged.
 * When the job itself has no cached location, no anchor/routing work is done.
 */
async function loadTravelSignals(
  organizationId: string,
  requestId: string,
  technicianIds: readonly string[],
): Promise<Map<string, { km: number | null; minutes: number | null }>> {
  const out = new Map<string, { km: number | null; minutes: number | null }>(
    technicianIds.map((id) => [id, { km: null, minutes: null }]),
  );
  const jobCoords = await loadJobCoords(organizationId, requestId);
  if (!jobCoords) return out;

  const anchors = await loadTechAnchors(organizationId, technicianIds);
  for (const id of technicianIds) {
    const a = anchors.get(id);
    if (a) {
      out.set(id, {
        km: haversineKm(a.lat, a.lon, jobCoords.lat, jobCoords.lon),
        minutes: null,
      });
    }
  }

  // Routing overlay (best-effort, one matrix call). Only techs with a known
  // anchor are priced; a null result leaves that tech on the haversine term.
  if (routingEnabled()) {
    const withAnchor = technicianIds.filter((id) => anchors.get(id));
    if (withAnchor.length > 0) {
      const origins = withAnchor.map((id) => {
        const a = anchors.get(id)!;
        return { lat: a.lat, lon: a.lon };
      });
      const minutes = await durationMatrix(origins, {
        lat: jobCoords.lat,
        lon: jobCoords.lon,
      });
      withAnchor.forEach((id, i) => {
        const m = minutes[i];
        if (m != null) out.set(id, { ...out.get(id)!, minutes: m });
      });
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

  // Latest live fix preferred — one query for all techs (not N).
  const fixes = await getLatestTechnicianLocations(organizationId, technicianIds);

  for (const id of technicianIds) {
    const fix = fixes.get(id);
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
