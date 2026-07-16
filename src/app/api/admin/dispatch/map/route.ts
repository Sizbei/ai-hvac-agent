import { and, desc, eq, gt, inArray, isNotNull, sql, asc } from "drizzle-orm";
import { getAdminSession } from "@/lib/auth/session";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import {
  serviceRequests,
  users,
  technicianLocations,
  customerLocations,
  customers,
  invoices,
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
 * location (consent-gated capture, last 4h), the business base, and AR customers
 * with open invoices that have a geocoded location. Admin session only.
 */
export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  }

  // Rate-limit per user: same pattern as sibling dispatch/route.ts.
  // The map fires up to 25 live geocodes + decrypts 200+ jobs / 300 AR rows —
  // cap it the same as other polled admin read surfaces (60 req/min/user).
  const rateCheck = slidingWindow(
    `admin:dispatch:map:${session.userId}`,
    RATE_LIMITS.adminRead.maxRequests,
    RATE_LIMITS.adminRead.windowMs,
  );
  if (!rateCheck.allowed) {
    return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
  }

  try {
    const base = {
      name: BUSINESS_BASE_LOCATION.name,
      latitude: BUSINESS_BASE_LOCATION.latitude,
      longitude: BUSINESS_BASE_LOCATION.longitude,
      serviceRadiusKm: BUSINESS_BASE_LOCATION.serviceRadiusKm,
    };

    // ── Run all 3 independent queries in parallel ──
    const effectiveAge = sql<number>`extract(epoch from now() - coalesce(${invoices.issuedAt}, ${invoices.createdAt})) / 86400`;
    const cutoff = new Date(Date.now() - TECH_FRESH_MS);

    const [jobRows, locRows, arRows] = await Promise.all([
      // Jobs ──
      // Prefer the cached coordinates from geocode-at-intake (customer_locations),
      // joined via the request's location_id. Only jobs still missing coords hit
      // Photon below — so a normal map load makes zero external calls and never
      // ships a decrypted address anywhere.
      db
        .select({
          id: serviceRequests.id,
          referenceNumber: serviceRequests.referenceNumber,
          status: serviceRequests.status,
          urgency: serviceRequests.urgency,
          issueType: serviceRequests.issueType,
          addressEncrypted: serviceRequests.addressEncrypted,
          arrivalWindowStart: serviceRequests.arrivalWindowStart,
          technicianName: users.name,
          // Customer name: prefer the name stored on the request itself (set at
          // intake), fall back to the linked customer row.
          customerNameEncrypted: serviceRequests.customerNameEncrypted,
          customerNameFromCustomer: customers.nameEncrypted,
          priceCents: sql<number | null>`(${serviceRequests.fieldpulseMetrics}->>'totalPriceCents')::int`,
          cachedLat: customerLocations.latitude,
          cachedLon: customerLocations.longitude,
        })
        .from(serviceRequests)
        .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
        .leftJoin(
          customers,
          and(
            eq(serviceRequests.customerId, customers.id),
            eq(customers.organizationId, session.organizationId),
          ),
        )
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
        .limit(200),

      // Technicians — DISTINCT ON (technician_id) returns one row per tech
      // (the latest fix) entirely in SQL; avoids fetching up to 500 rows
      // and deduplicating in JS. Stale-fix filter (> 4h) applied in JS below
      // (cutoff depends on request time, not a stored column).
      db
        .selectDistinctOn([technicianLocations.technicianId], {
          technicianId: technicianLocations.technicianId,
          name: users.name,
          latitude: technicianLocations.latitude,
          longitude: technicianLocations.longitude,
          capturedAt: technicianLocations.capturedAt,
        })
        .from(technicianLocations)
        .innerJoin(users, eq(technicianLocations.technicianId, users.id))
        .where(withTenant(technicianLocations, session.organizationId))
        // DISTINCT ON requires ORDER BY to lead with the distinct column;
        // capturedAt DESC tiebreak keeps the most-recent fix per tech.
        .orderBy(
          asc(technicianLocations.technicianId),
          desc(technicianLocations.capturedAt),
        ),

      // AR customers — open invoices with a geocoded location.
      // One row per customer: sum of outstanding balance, invoice count, oldest age.
      // Only customers that have at least one geocoded customer_location are returned.
      db
        .select({
          customerId: customers.id,
          nameEncrypted: customers.nameEncrypted,
          latitude: customerLocations.latitude,
          longitude: customerLocations.longitude,
          owingCents: sql<number>`sum(${invoices.totalCents} - coalesce(${invoices.amountPaidCents}, 0))`,
          invoiceCount: sql<number>`count(${invoices.id})`,
          oldestDays: sql<number>`max(${effectiveAge})`,
        })
        .from(invoices)
        .innerJoin(customers, and(
          eq(invoices.customerId, customers.id),
          eq(customers.organizationId, session.organizationId),
        ))
        .innerJoin(
          customerLocations,
          and(
            eq(customerLocations.customerId, customers.id),
            eq(customerLocations.organizationId, session.organizationId),
            isNotNull(customerLocations.latitude),
          ),
        )
        .where(
          and(
            withTenant(invoices, session.organizationId),
            eq(invoices.state, "open"),
            gt(invoices.totalCents, sql`coalesce(${invoices.amountPaidCents}, 0)`),
          ),
        )
        .groupBy(customers.id, customers.nameEncrypted, customerLocations.latitude, customerLocations.longitude)
        .limit(300),
    ]);

    type JobRow = (typeof jobRows)[number];
    const project = (r: JobRow, latitude: number, longitude: number) => ({
      id: r.id,
      referenceNumber: r.referenceNumber,
      status: r.status,
      urgency: r.urgency,
      issueType: r.issueType,
      technicianName: r.technicianName,
      arrivalWindowStart: r.arrivalWindowStart?.toISOString() ?? null,
      customerName:
        safeDecrypt(r.customerNameEncrypted) ??
        safeDecrypt(r.customerNameFromCustomer),
      priceCents: r.priceCents ?? null,
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

    // Filter stale tech fixes in JS (cutoff depends on request time).
    const technicians: Array<{
      technicianId: string;
      name: string;
      latitude: number;
      longitude: number;
      capturedAt: string;
    }> = [];
    for (const l of locRows) {
      if (l.capturedAt < cutoff) continue; // stale
      technicians.push({
        technicianId: l.technicianId,
        name: l.name,
        latitude: l.latitude,
        longitude: l.longitude,
        capturedAt: l.capturedAt.toISOString(),
      });
    }

    const arCustomers = arRows.map((r) => ({
      customerId: r.customerId,
      name: safeDecrypt(r.nameEncrypted),
      latitude: r.latitude,
      longitude: r.longitude,
      owingCents: Number(r.owingCents),
      invoiceCount: Number(r.invoiceCount),
      oldestDays: Math.round(Number(r.oldestDays)),
    }));

    return successResponse({
      base,
      jobs,
      technicians,
      arCustomers,
      geocodeCapped: needGeocode.length > MAX_GEOCODE,
    });
  } catch (error) {
    logger.error({ error }, "Failed to build dispatch map data");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
