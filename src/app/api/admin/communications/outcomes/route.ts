/**
 * GET /api/admin/communications/outcomes
 *
 * Thin read surface for the comms-health view: a tenant-scoped summary of the
 * communication queue's outcomes (sent/failed/pending, consent-suppressed jobs
 * bucketed by reason, and the RESEND-unset email stall). No PII.
 *
 * Optional `?sinceDays=N` limits to jobs created in the last N days.
 */
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { getCommsOutcomeSummary } from "@/lib/communication/observability";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:comms-outcomes:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const sinceDaysParam = request.nextUrl.searchParams.get("sinceDays");
    const sinceDays = sinceDaysParam ? Number(sinceDaysParam) : undefined;
    const sinceMs =
      sinceDays !== undefined && Number.isFinite(sinceDays) && sinceDays > 0
        ? Date.now() - sinceDays * DAY_MS
        : undefined;

    const summary = await getCommsOutcomeSummary(
      session.organizationId,
      sinceMs,
    );

    return successResponse({ summary });
  } catch (error) {
    logger.error({ error }, "Failed to fetch comms outcome summary");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
