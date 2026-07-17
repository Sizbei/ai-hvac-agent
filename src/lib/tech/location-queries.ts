/**
 * Technician live-location capture — consent-gated.
 *
 * A fix is only stored when the tech has explicitly turned location sharing ON
 * (users.location_sharing_enabled). The consent check is enforced SERVER-side
 * here, not just in the client, so a stale/replaying client can't post fixes
 * after the tech revokes. Coords are plain doubles (not blind-indexed — a live
 * position isn't the same PII shape as an encrypted address). Every read/write is
 * org + technician scoped.
 */
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  technicianLocations,
  users,
  serviceRequests,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface LocationFixInput {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyM?: number | null;
  readonly heading?: number | null;
  readonly capturedAt: Date;
  readonly serviceRequestId?: string | null;
}

export type RecordLocationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "no_consent" | "invalid_input" };

/** A finite lat/lng inside the valid WGS84 ranges. */
export function isValidCoordinate(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Store one GPS fix for the tech — IFF they currently consent to location
 * sharing. Returns no_consent (caller → 403) when sharing is off, so revoking
 * consent immediately stops ingestion regardless of what the client does.
 */
export async function recordTechnicianLocation(
  organizationId: string,
  technicianId: string,
  input: LocationFixInput,
): Promise<RecordLocationResult> {
  if (!isValidCoordinate(input.latitude, input.longitude)) {
    return { ok: false, reason: "invalid_input" };
  }

  const [u] = await db
    .select({ enabled: users.locationSharingEnabled })
    .from(users)
    .where(withTenant(users, organizationId, eq(users.id, technicianId)))
    .limit(1);
  if (!u || !u.enabled) {
    return { ok: false, reason: "no_consent" };
  }

  // The serviceRequestId is client-supplied. Only link it if it's a real request
  // in THIS org AND assigned to THIS tech — otherwise a cross-org or cross-tech
  // id would corrupt dispatch ETA/travel signals for another technician.
  // Fall back to null (an unlinked fix is fine; no error returned to client).
  let linkedRequestId: string | null = null;
  if (input.serviceRequestId) {
    const [req] = await db
      .select({ id: serviceRequests.id })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          and(
            eq(serviceRequests.id, input.serviceRequestId),
            eq(serviceRequests.assignedTo, technicianId),
          )!,
        ),
      )
      .limit(1);
    linkedRequestId = req?.id ?? null;
  }

  await db.insert(technicianLocations).values({
    organizationId,
    technicianId,
    serviceRequestId: linkedRequestId,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracyM: input.accuracyM ?? null,
    heading: input.heading ?? null,
    capturedAt: input.capturedAt,
  });
  return { ok: true };
}

/** Turn location sharing on/off for a tech and stamp when they decided. */
export async function setLocationConsent(
  organizationId: string,
  technicianId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(users)
    .set({
      locationSharingEnabled: enabled,
      locationConsentUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(withTenant(users, organizationId, eq(users.id, technicianId)));
}

/** Whether the tech currently consents to location sharing. */
export async function getLocationConsent(
  organizationId: string,
  technicianId: string,
): Promise<boolean> {
  const [u] = await db
    .select({ enabled: users.locationSharingEnabled })
    .from(users)
    .where(withTenant(users, organizationId, eq(users.id, technicianId)))
    .limit(1);
  return u?.enabled ?? false;
}

export interface TechLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyM: number | null;
  readonly capturedAt: string;
}

/** The most recent fix for a tech (for travel-aware dispatch / behind-schedule
 * projection). Null when none / consent never granted. */
export async function getLatestTechnicianLocation(
  organizationId: string,
  technicianId: string,
): Promise<TechLocation | null> {
  const [row] = await db
    .select({
      latitude: technicianLocations.latitude,
      longitude: technicianLocations.longitude,
      accuracyM: technicianLocations.accuracyM,
      capturedAt: technicianLocations.capturedAt,
    })
    .from(technicianLocations)
    .where(
      withTenant(
        technicianLocations,
        organizationId,
        eq(technicianLocations.technicianId, technicianId),
      ),
    )
    .orderBy(desc(technicianLocations.capturedAt))
    .limit(1);
  if (!row) return null;
  return {
    latitude: row.latitude,
    longitude: row.longitude,
    accuracyM: row.accuracyM,
    capturedAt: row.capturedAt.toISOString(),
  };
}

/**
 * How recent a GPS fix must be to count as a tech's LIVE location for dispatch
 * routing. Fixes are retained ~30 days, but an old fix is NOT where the tech is
 * now — using it would mis-price the dominant travel term off yesterday's
 * coordinates. Beyond this window the fix is dropped and the caller falls back
 * to the tech's home base, a more honest anchor for someone who isn't actively
 * reporting position.
 */
export const LIVE_FIX_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Latest fix per technician for a set of techs, in ONE query (avoids the N+1 of
 * calling getLatestTechnicianLocation per tech from the dispatch scorer).
 * DISTINCT ON (technician_id) bounds the result to one row per tech at the
 * database — the row transfer stays O(techs) no matter how much GPS history the
 * table holds (history itself is trimmed by the cleanup cron's retention sweep).
 * A tech is absent from the map when they have NO fix OR their latest fix is
 * older than {@link LIVE_FIX_MAX_AGE_MS}. Org + technician scoped. `now` is
 * injectable for deterministic tests.
 */
export async function getLatestTechnicianLocations(
  organizationId: string,
  technicianIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, { readonly latitude: number; readonly longitude: number }>> {
  const out = new Map<string, { latitude: number; longitude: number }>();
  if (technicianIds.length === 0) return out;

  const cutoff = new Date(now.getTime() - LIVE_FIX_MAX_AGE_MS);
  const rows = await db
    .selectDistinctOn([technicianLocations.technicianId], {
      technicianId: technicianLocations.technicianId,
      latitude: technicianLocations.latitude,
      longitude: technicianLocations.longitude,
      capturedAt: technicianLocations.capturedAt,
    })
    .from(technicianLocations)
    .where(
      withTenant(
        technicianLocations,
        organizationId,
        inArray(technicianLocations.technicianId, [...technicianIds]),
        // Only fixes within the freshness window — a stale fix is not a live
        // location. (JS-side guard below is defense-in-depth for any caller/
        // mock that bypasses this predicate.)
        gte(technicianLocations.capturedAt, cutoff),
      ),
    )
    // DISTINCT ON requires ORDER BY to lead with the distinct column; the
    // capturedAt desc tiebreak makes the one kept row the LATEST fix.
    .orderBy(technicianLocations.technicianId, desc(technicianLocations.capturedAt));

  const cutoffMs = cutoff.getTime();
  for (const r of rows) {
    if (out.has(r.technicianId)) continue; // defense-in-depth; rows are unique per tech
    if (r.capturedAt == null || r.capturedAt.getTime() < cutoffMs) continue; // stale → skip
    out.set(r.technicianId, { latitude: r.latitude, longitude: r.longitude });
  }
  return out;
}
