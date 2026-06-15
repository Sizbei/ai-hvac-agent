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
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { db } from "@/lib/db";
import { fieldpulseConnections } from "@/lib/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { withTenant } from "@/lib/db/tenant";
import {
  syncAvailabilityFromFieldpulse,
  getAvailabilitySyncStatus,
} from "@/lib/integrations/fieldpulse/availability-sync";

/**
 * Verify the cron secret from the Authorization header.
 *
 * Expected format: Authorization: Bearer <CRON_SECRET>
 * Returns false if the header is missing, malformed, or the secret doesn't match.
 */
function verifyCronSecret(authHeader: string | null): boolean {
  if (!authHeader) {
    return false;
  }

  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    logger.warn("CRON_SECRET not set - cron endpoint is disabled");
    return false;
  }

  // Parse Bearer token
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return false;
  }

  return parts[1] === expectedSecret;
}

export async function GET(request: Request): Promise<Response> {
  try {
    // Verify cron secret
    const authHeader = request.headers.get("Authorization");
    if (!verifyCronSecret(authHeader)) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    logger.info("Starting scheduled Fieldpulse availability sync");

    // Fetch all Fieldpulse-connected organizations
    const connections = await db
      .select({
        organizationId: fieldpulseConnections.organizationId,
        status: fieldpulseConnections.availabilitySyncStatus,
      })
      .from(fieldpulseConnections)
      .where(
        and(
          eq(fieldpulseConnections.connected, true),
          // Only sync orgs that have completed a previous sync or are pending
          // Skip those currently in progress to prevent overlap
        ),
      );

    let initiated = 0;
    let skipped = 0;
    const errors: Array<{ organizationId: string; error: string }> = [];

    for (const connection of connections) {
      const { organizationId } = connection;

      try {
        // Check if sync is already in progress for this org
        const currentStatus = await getAvailabilitySyncStatus(organizationId);

        if (currentStatus.status === "in_progress") {
          skipped++;
          logger.debug(
            { organizationId },
            "Skipping org - sync already in progress",
          );
          continue;
        }

        // Initiate sync in the background (fire and forget)
        // We don't await - let each org's sync run independently
        syncAvailabilityFromFieldpulse(organizationId).catch((error) => {
          logger.error(
            { organizationId, error },
            "Cron-triggered availability sync failed",
          );
        });

        initiated++;
        logger.info({ organizationId }, "Initiated cron availability sync");
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors.push({ organizationId, error: errorMessage });
        logger.error(
          { organizationId, error },
          "Failed to initiate availability sync for org",
        );
      }
    }

    logger.info(
      {
        totalConnections: connections.length,
        initiated,
        skipped,
        errors: errors.length,
      },
      "Completed scheduled Fieldpulse availability sync",
    );

    return successResponse({
      initiated,
      skipped,
      errors,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Scheduled availability sync failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
