import { NextRequest } from "next/server";
import { sql, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions, messages, technicianLocations } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { verifyCronAuth } from "@/lib/cron-auth";

interface CleanupSummary {
  readonly expiredSessions: number;
  readonly purgedSessions: number;
  readonly purgedMessages: number;
  readonly purgedLocationFixes: number;
}

export async function GET(request: NextRequest) {
  // Step 1: Auth check — validate Bearer token against CRON_SECRET.
  // Fail CLOSED if the secret is missing/blank: otherwise the expected token
  // collapses to "Bearer undefined" / "Bearer " and this destructive endpoint
  // (it purges sessions and messages) could be triggered by an unauthenticated
  // caller who guesses the misconfigured value.
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    logger.error({}, "CRON_SECRET is not configured; refusing cleanup");
    return errorResponse(
      "Cron endpoint not configured",
      "NOT_CONFIGURED",
      503,
    );
  }

  // Timing-safe Bearer comparison (constant-time; no char-by-char leak).
  if (!verifyCronAuth(request.headers.get("authorization"))) {
    return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  }

  try {
    // Step 2: Expire stale sessions — chatting/extracting older than 24h. Set
    // outcome='abandoned' in the SAME write so the outcome enum is always
    // populated (Stage 3 criterion: every closed session has an outcome). LLM
    // recaps are reserved for the meaningful closes (booking/escalation) — an
    // abandoned/timed-out session typically has nothing to summarize.
    const expireResult = await db
      .update(customerSessions)
      .set({ status: "abandoned", outcome: "abandoned" })
      .where(
        sql`${customerSessions.status} IN ('chatting', 'extracting') AND ${customerSessions.updatedAt} < NOW() - INTERVAL '24 hours'`,
      );

    const expiredSessions = (expireResult as { rowCount?: number }).rowCount ?? 0;

    // Step 3: Purge old data — sessions and messages older than 90 days
    const staleSessions = await db
      .select({ id: customerSessions.id })
      .from(customerSessions)
      .where(
        sql`${customerSessions.createdAt} < NOW() - INTERVAL '90 days'`,
      );

    let purgedMessages = 0;
    let purgedSessions = 0;

    if (staleSessions.length > 0) {
      const sessionIds = staleSessions.map((s) => s.id);

      // Delete messages first (referential integrity)
      const msgResult = await db
        .delete(messages)
        .where(inArray(messages.sessionId, sessionIds));

      purgedMessages = (msgResult as { rowCount?: number }).rowCount ?? 0;

      // Delete the sessions themselves
      const sessResult = await db
        .delete(customerSessions)
        .where(inArray(customerSessions.id, sessionIds));

      purgedSessions = (sessResult as { rowCount?: number }).rowCount ?? 0;
    }

    // Step 4: Trim technician GPS history — dispatch/map only ever read the
    // LATEST fix (and the map's freshness window is 4h), so old pings are pure
    // growth. 30 days retained for future geofence/actual-duration analysis.
    // This is the retention the technician_locations schema comment promises.
    const locResult = await db
      .delete(technicianLocations)
      .where(
        sql`${technicianLocations.capturedAt} < NOW() - INTERVAL '30 days'`,
      );
    const purgedLocationFixes =
      (locResult as { rowCount?: number }).rowCount ?? 0;

    const summary: CleanupSummary = {
      expiredSessions,
      purgedSessions,
      purgedMessages,
      purgedLocationFixes,
    };

    logger.info({ cleanup: summary }, "Session cleanup completed");

    return successResponse(summary);
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error({ error: errorMessage }, "Session cleanup failed");
    return errorResponse("Cleanup failed", "INTERNAL_ERROR", 500);
  }
}
