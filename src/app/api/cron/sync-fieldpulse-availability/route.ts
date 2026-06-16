/**
 * Scheduled Fieldpulse availability sync via Vercel cron.
 *
 *   GET — trigger availability sync for all Fieldpulse-connected orgs.
 *   (Vercel Cron invokes scheduled endpoints with GET.)
 *
 * Called by Vercel cron on a schedule (e.g., every hour). Iterates over all
 * organizations with active Fieldpulse connections and initiates an availability
 * sync for each.
 *
 * AUTH: Protected by a cron secret (CRON_SECRET env var) to prevent unauthorized
 * triggers. The secret must be passed in the Authorization header as a Bearer token.
 *
 * This endpoint is designed to be idempotent — multiple invocations will not
 * cause duplicate syncs for orgs that are already in progress.
 *
 * Returns a summary of syncs initiated vs skipped (already in progress).
 */
import { after } from "next/server";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { db } from "@/lib/db";
import { fieldpulseConnections } from "@/lib/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { verifyCronAuth } from "@/lib/cron-auth";
import { syncAvailabilityFromFieldpulse } from "@/lib/integrations/fieldpulse/availability-sync";

export async function GET(request: Request): Promise<Response> {
  try {
    // Verify cron secret (timing-safe Bearer compare, fails closed).
    if (!verifyCronAuth(request.headers.get("Authorization"))) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    logger.info("Starting scheduled Fieldpulse availability sync");

    // Fetch connected orgs that aren't already syncing — skip in-progress at the
    // query level so the cron doesn't waste a per-org status round-trip on them.
    const connections = await db
      .select({
        organizationId: fieldpulseConnections.organizationId,
        status: fieldpulseConnections.availabilitySyncStatus,
      })
      .from(fieldpulseConnections)
      .where(
        and(
          eq(fieldpulseConnections.connected, true),
          ne(fieldpulseConnections.availabilitySyncStatus, "in_progress"),
        ),
      );

    let initiated = 0;

    // in-progress orgs are already excluded by the query above, and the atomic
    // claimSync inside syncAvailabilityFromFieldpulse is the REAL concurrency
    // guard — so we don't re-check status per org (no wasted round-trips).
    for (const connection of connections) {
      const { organizationId } = connection;

      // Initiate sync in the background. after() keeps each org's sync alive
      // past the cron response (a detached promise is frozen on Vercel). Each
      // sync self-guards via claimSync, so a racing manual trigger is harmless.
      after(async () => {
        try {
          await syncAvailabilityFromFieldpulse(organizationId);
        } catch (error) {
          logger.error(
            { organizationId, error },
            "Cron-triggered availability sync failed",
          );
        }
      });

      initiated++;
    }

    logger.info(
      { totalConnections: connections.length, initiated },
      "Completed scheduled Fieldpulse availability sync",
    );

    return successResponse({ initiated });
  } catch (error: unknown) {
    logger.error({ error }, "Scheduled availability sync failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
