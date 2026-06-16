/**
 * Manual Fieldpulse availability sync trigger.
 *
 *   POST — trigger a background sync of technician availability from Fieldpulse.
 *
 * Admin-session-gated. Initiates an availability sync job that runs in the
 * background. Returns immediately with the job status. The actual sync happens
 * asynchronously to avoid blocking the admin UI.
 *
 * The response includes:
 * - initiated: true if the sync was started
 * - status: current sync status (pending, in_progress, completed, failed)
 * - lastSyncAt: timestamp of last successful sync (null if never synced)
 * - lastError: error message from last failed sync (null if none)
 *
 * If a sync is already in progress, returns 409 Conflict with the current status.
 */
import { after } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  syncAvailabilityFromFieldpulse,
  getAvailabilitySyncStatus,
} from "@/lib/integrations/fieldpulse/availability-sync";

export async function POST(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:fieldpulse-sync-availability:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    // Check current sync status
    const currentStatus = await getAvailabilitySyncStatus(session.organizationId);

    // Prevent starting a new sync if one is already in progress
    if (currentStatus.status === "in_progress") {
      return errorResponse(
        "Sync already in progress",
        "SYNC_IN_PROGRESS",
        409,
        {
          status: currentStatus.status,
          lastSyncAt: currentStatus.lastSyncAt?.toISOString() ?? null,
          lastError: currentStatus.lastError,
        },
      );
    }

    // Initiate sync in the background. after() keeps the work alive past the
    // response on Vercel (a detached promise would be frozen when the Lambda
    // returns, leaving availabilitySyncStatus stuck "in_progress").
    after(async () => {
      try {
        await syncAvailabilityFromFieldpulse(session.organizationId);
      } catch (error) {
        logger.error(
          { organizationId: session.organizationId, error },
          "Background availability sync failed",
        );
      }
    });

    logger.info(
      { organizationId: session.organizationId, userId: session.userId },
      "Initiated Fieldpulse availability sync",
    );

    // Return immediately with the status before the sync completes
    return successResponse({
      initiated: true,
      status: "in_progress",
      lastSyncAt: currentStatus.lastSyncAt?.toISOString() ?? null,
      lastError: currentStatus.lastError,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to initiate availability sync");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

/**
 * GET — retrieve current availability sync status.
 *
 * Returns the current sync state without triggering a new sync. Used by the
 * admin UI to display sync status and last sync time.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:fieldpulse-sync-status:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const status = await getAvailabilitySyncStatus(session.organizationId);

    return successResponse({
      status: status.status,
      lastSyncAt: status.lastSyncAt?.toISOString() ?? null,
      lastError: status.lastError,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to retrieve availability sync status");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
