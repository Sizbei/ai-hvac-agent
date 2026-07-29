/**
 * Vercel Cron — AI online-booking recovery (Stage 6).
 *
 * Sweeps abandoned SMS conversations across all orgs and sends one consent-gated,
 * ledger-deduped recovery nudge each. Auth: Bearer CRON_SECRET (fail closed).
 */
import { and, eq, gte, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, serviceRequests } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { verifyCronAuth } from "@/lib/cron-auth";
import {
  recoverAbandonedBookings,
  recoverAbandonedWebSessions,
} from "@/lib/communication/booking-recovery";
import { persistJobLocation } from "@/lib/requests/persist-job-location";
import { decrypt } from "@/lib/crypto";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Cap on how many missing-geocode requests we backfill per org per run — keeps
 * the (rate-limited) Photon calls bounded. */
const GEOCODE_BACKFILL_LIMIT = 25;

/**
 * Backfill missing job coordinates for one org: recent, non-terminal requests
 * whose location_id is still null (persistJobLocation missed at booking — a
 * geocoder blip, or a request created before the intake-geocode landed). Each
 * row is geocoded + linked via the same idempotent, degrade-safe helper the
 * booking path uses. Per-row try/catch so one bad address never aborts the sweep.
 * Returns how many rows were successfully linked.
 */
async function backfillMissingGeocodes(organizationId: string): Promise<number> {
  const rows = await db
    .select({
      id: serviceRequests.id,
      customerId: serviceRequests.customerId,
      addressEncrypted: serviceRequests.addressEncrypted,
    })
    .from(serviceRequests)
    .where(
      and(
        eq(serviceRequests.organizationId, organizationId),
        isNull(serviceRequests.locationId),
        notInArray(serviceRequests.status, ["completed", "cancelled"]),
        gte(serviceRequests.createdAt, sql`now() - interval '14 days'`),
      ),
    )
    .limit(GEOCODE_BACKFILL_LIMIT);

  let linked = 0;
  for (const row of rows) {
    // Need both a customer (to hang the location off) and an address to geocode.
    if (!row.customerId || !row.addressEncrypted) continue;
    try {
      const address = decrypt(row.addressEncrypted);
      await persistJobLocation({
        organizationId,
        customerId: row.customerId,
        serviceRequestId: row.id,
        address,
      });
      linked += 1;
    } catch (error) {
      logger.error(
        { error, organizationId, serviceRequestId: row.id },
        "Geocode backfill failed for request (non-fatal)",
      );
    }
  }
  return linked;
}

export async function GET(request: Request) {
  if (!verifyCronAuth(request.headers.get("authorization"))) {
    return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  }
  try {
    const orgs = await db.select({ id: organizations.id }).from(organizations);
    let sent = 0;
    let considered = 0;
    let webSent = 0;
    let webConsidered = 0;
    let geocodesBackfilled = 0;
    for (const org of orgs) {
      try {
        const r = await recoverAbandonedBookings(org.id);
        sent += r.sent;
        considered += r.considered;
      } catch (error) {
        logger.error({ error, organizationId: org.id }, "Recovery pass failed for org");
      }
      // Web-abandon recovery is folded into the same sweep but failure-isolated
      // from the SMS pass — a web error must never abort booking recovery.
      try {
        const w = await recoverAbandonedWebSessions(org.id);
        webSent += w.sent;
        webConsidered += w.considered;
      } catch (error) {
        logger.error({ error, organizationId: org.id }, "Web-recovery pass failed for org");
      }
      // Geocode backfill for recent, non-terminal, un-located requests. Folded
      // into the same sweep but failure-isolated — a geocode error must never
      // abort recovery.
      try {
        geocodesBackfilled += await backfillMissingGeocodes(org.id);
      } catch (error) {
        logger.error({ error, organizationId: org.id }, "Geocode-backfill pass failed for org");
      }
    }
    return successResponse({
      orgs: orgs.length,
      considered,
      sent,
      webConsidered,
      webSent,
      geocodesBackfilled,
    });
  } catch (error) {
    logger.error({ error }, "Booking-recovery cron failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
