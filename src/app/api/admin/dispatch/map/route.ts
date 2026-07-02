import { and, desc, eq, inArray } from "drizzle-orm";
import { getAdminSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import {
  serviceRequests,
  users,
  technicianLocations,
  customerLocations,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { fetchAddressSuggestions } from "@/lib/address/photon";
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const ACTIVE_STATUSES = ["scheduled", "assigned", "in_progress", "on_hold"] as const;
// Most jobs carry cached coordinates from geocode-at-intake (customer_locations).
// Only jobs still missing them (a booking taken seconds ago, pre-geocode) fall
// back to a live Photon lookup — capped to bound latency, be a good Photon
// citizen, and limit how much plaintext address ever leaves the system.
const MAX_GEOCODE = 25;
// Only show a tech's pin if their last fix is reasonably fresh.
const TECH_FRESH_MS = 4 * 60 * 60 * 1000;

function safeDecrypt(v: string | null): string | null {
  if (!v) return null;
  try {
    return decrypt(v);
  } catch {
    return null;
  }
}

/**
 * GET /api/admin/dispatch/map — the data behind the dispatch map: active jobs
 * (coordinates from the cached customer_locations row, falling back to a live
 * Photon lookup only for jobs not yet geocoded), each technician's latest live
 * location (consent-gated capture, last 4h), and the business base. Admin
 * session only. PII-light: returns reference/status/urgency + coords, no
 * customer name or raw address.
 */
export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  }

  try {
    const base = {
      name: BUSINESS_BASE_LOCATION.name,
      latitude: BUSINESS_BASE_LOCATION.latitude,
      longitude: BUSINESS_BASE_LOCATION.longitude,
      serviceRadiusKm: BUSINESS_BASE_LOCATION.serviceRadiusKm,
    };

    // ── Jobs ──
    // Prefer the cached coordinates from geocode-at-intake (customer_locations),
    // joined via the request's location_id. Only jobs still missing coords hit
    // Photon below — so a normal map load makes zero external calls and never
    // ships a decrypted address anywhere.
    const jobRows = await db
      .select({
        id: serviceRequests.id,
        referenceNumber: serviceRequests.referenceNumber,
        status: serviceRequests.status,
        urgency: serviceRequests.urgency,
        issueType: serviceRequests.issueType,
        addressEncrypted: serviceRequests.addressEncrypted,
        arrivalWindowStart: serviceRequests.arrivalWindowStart,
        technicianName: users.name,
        cachedLat: customerLocations.latitude,
        cachedLon: customerLocations.longitude,
      })
      .from(serviceRequests)
      .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
      .leftJoin(
        customerLocations,
        and(
          eq(customerLocations.id, serviceRequests.locationId),
          eq(customerLocations.organizationId, session.organizationId),
        ),
      )
      .where(
        withTenant(
          serviceRequests,
          session.organizationId,
          inArray(serviceRequests.status, [...ACTIVE_STATUSES]),
        ),
      )
      .limit(200);

    type JobRow = (typeof jobRows)[number];
    const project = (r: JobRow, latitude: number, longitude: number) => ({
      id: r.id,
      referenceNumber: r.referenceNumber,
      status: r.status,
      urgency: r.urgency,
      issueType: r.issueType,
      technicianName: r.technicianName,
      arrivalWindowStart: r.arrivalWindowStart?.toISOString() ?? null,
      latitude,
      longitude,
    });

    const cached: ReturnType<typeof project>[] = [];
    const needGeocode: JobRow[] = [];
    for (const r of jobRows) {
      if (r.cachedLat != null && r.cachedLon != null) {
        cached.push(project(r, r.cachedLat, r.cachedLon));
      } else {
        needGeocode.push(r);
      }
    }

    // Fallback for the not-yet-geocoded tail only (best-effort, capped).
    const geocoded = await Promise.all(
      needGeocode.slice(0, MAX_GEOCODE).map(async (r) => {
        const address = safeDecrypt(r.addressEncrypted);
        if (!address) return null;
        const [hit] = await fetchAddressSuggestions(address, {
          near: { lat: base.latitude, lon: base.longitude },
        });
        if (!hit || hit.lat == null || hit.lon == null) return null;
        return project(r, hit.lat, hit.lon);
      }),
    );
    const jobs = [
      ...cached,
      ...geocoded.filter((j): j is NonNullable<typeof j> => j !== null),
    ];

    // ── Technicians (latest fresh fix per tech) ──
    const locRows = await db
      .select({
        technicianId: technicianLocations.technicianId,
        name: users.name,
        latitude: technicianLocations.latitude,
        longitude: technicianLocations.longitude,
        capturedAt: technicianLocations.capturedAt,
      })
      .from(technicianLocations)
      .innerJoin(users, eq(technicianLocations.technicianId, users.id))
      .where(withTenant(technicianLocations, session.organizationId))
      .orderBy(desc(technicianLocations.capturedAt))
      .limit(500);

    const cutoff = Date.now() - TECH_FRESH_MS;
    const seen = new Set<string>();
    const technicians: Array<{
      technicianId: string;
      name: string;
      latitude: number;
      longitude: number;
      capturedAt: string;
    }> = [];
    for (const l of locRows) {
      if (seen.has(l.technicianId)) continue; // rows are desc → first is latest
      seen.add(l.technicianId);
      if (l.capturedAt.getTime() < cutoff) continue; // stale
      technicians.push({
        technicianId: l.technicianId,
        name: l.name,
        latitude: l.latitude,
        longitude: l.longitude,
        capturedAt: l.capturedAt.toISOString(),
      });
    }

    return successResponse({
      base,
      jobs,
      technicians,
      geocodeCapped: needGeocode.length > MAX_GEOCODE,
    });
  } catch (error) {
    logger.error({ error }, "Failed to build dispatch map data");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
