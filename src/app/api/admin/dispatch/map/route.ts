import { desc, eq, inArray } from "drizzle-orm";
import { getAdminSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { serviceRequests, users, technicianLocations } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { fetchAddressSuggestions } from "@/lib/address/photon";
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const ACTIVE_STATUSES = ["scheduled", "assigned", "in_progress", "on_hold"] as const;
// Geocoding is per-load and best-effort; cap the calls to bound latency + be a
// good Photon citizen. (A persistent geocode cache is the follow-up.)
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
 * geocoded from their service address (best-effort via Photon), each technician's
 * latest live location (consent-gated capture, last 4h), and the business base.
 * Admin session only. PII-light: returns reference/status/urgency + coords, no
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

    // ── Jobs (geocoded) ──
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
      })
      .from(serviceRequests)
      .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
      .where(
        withTenant(
          serviceRequests,
          session.organizationId,
          inArray(serviceRequests.status, [...ACTIVE_STATUSES]),
        ),
      )
      .limit(200);

    const geocoded = await Promise.all(
      jobRows.slice(0, MAX_GEOCODE).map(async (r) => {
        const address = safeDecrypt(r.addressEncrypted);
        if (!address) return null;
        const [hit] = await fetchAddressSuggestions(address, {
          near: { lat: base.latitude, lon: base.longitude },
        });
        if (!hit || hit.lat == null || hit.lon == null) return null;
        return {
          id: r.id,
          referenceNumber: r.referenceNumber,
          status: r.status,
          urgency: r.urgency,
          issueType: r.issueType,
          technicianName: r.technicianName,
          arrivalWindowStart: r.arrivalWindowStart?.toISOString() ?? null,
          latitude: hit.lat,
          longitude: hit.lon,
        };
      }),
    );
    const jobs = geocoded.filter((j): j is NonNullable<typeof j> => j !== null);

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
      geocodeCapped: jobRows.length > MAX_GEOCODE,
    });
  } catch (error) {
    logger.error({ error }, "Failed to build dispatch map data");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
