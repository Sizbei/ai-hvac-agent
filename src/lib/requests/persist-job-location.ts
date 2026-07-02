/**
 * Best-effort job-location persistence — the coordinate cache for the dispatch
 * map and travel-aware autodispatch.
 *
 * At booking we already have the customer's plaintext service address, but the
 * coordinates Photon resolves for it at intake are thrown away. This geocodes
 * that address ONCE (Photon, biased toward the business base so a same-street
 * match near the shop ranks first), caches the fix as a `customer_locations`
 * row (deduped within the customer), and links it to the just-created request
 * via `service_requests.location_id`. The dispatch map then reads cached coords
 * instead of geocoding per load, and the (dormant) travel term in dispatch
 * scoring has real coordinates to score against.
 *
 * DEGRADE-SAFE by construction: this is meant to run inside an `after()`
 * callback off the booking's hot path. It adds ZERO latency to the response,
 * NEVER throws out (every failure — no geocode match, geocoder down, db error —
 * is swallowed and logged), and NEVER affects the booking that already
 * committed. A missing coordinate simply means the map falls back to on-demand
 * geocoding, exactly as it does today.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { fetchAddressSuggestions } from "@/lib/address/photon";
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import { upsertCustomerLocation } from "@/lib/admin/location-queries";
import { logger } from "@/lib/logger";

export async function persistJobLocation(params: {
  readonly organizationId: string;
  readonly customerId: string;
  readonly serviceRequestId: string;
  readonly address: string;
}): Promise<void> {
  const { organizationId, customerId, serviceRequestId, address } = params;
  try {
    const trimmed = address?.trim();
    if (!trimmed) return;

    const suggestions = await fetchAddressSuggestions(trimmed, {
      near: {
        lat: BUSINESS_BASE_LOCATION.latitude,
        lon: BUSINESS_BASE_LOCATION.longitude,
      },
    });
    // fetchAddressSuggestions already sorts by distance from `near`, so the first
    // suggestion carrying real coordinates is the nearest-to-base match. No
    // coordinate resolved → nothing to cache; the map keeps geocoding on demand.
    const geo = suggestions.find((s) => s.lat != null && s.lon != null);
    if (!geo || geo.lat == null || geo.lon == null) return;

    // Cache the fix on a customer location (idempotent: a re-run resolves to the
    // same location id via the address blind index).
    const locationId = await upsertCustomerLocation(organizationId, customerId, {
      address: trimmed,
      latitude: geo.lat,
      longitude: geo.lon,
    });

    // Link the location to the request (tenant-scoped). Idempotent — a re-run
    // sets the same id.
    await db
      .update(serviceRequests)
      .set({ locationId, updatedAt: new Date() })
      .where(
        and(
          eq(serviceRequests.id, serviceRequestId),
          eq(serviceRequests.organizationId, organizationId),
        ),
      );
  } catch (err) {
    logger.error(
      { error: err, serviceRequestId, customerId },
      "persistJobLocation failed (non-fatal) — job coords not cached",
    );
  }
}
