/**
 * Admin payment reconciliation surface.
 *
 *   GET  — list this org's stranded ('pending', older than the cutoff) payments
 *          so the dashboard can show a "Needs attention" banner.
 *   POST — sweep + reconcile this org's stranded payments against the provider.
 *
 * Both are tenant-scoped to the session's org. POST is the on-demand counterpart
 * to the daily reconcile-payments cron (the cron is the safety net; this is the
 * operator's "fix it now" button).
 */
import { getAdminSession } from "@/lib/auth/session";
import {
  listStuckPayments,
  reconcileOrgPendingPayments,
} from "@/lib/admin/invoice-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:reconcile-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const stuck = await listStuckPayments(session.organizationId);
    return successResponse({ stuck });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list stuck payments");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:reconcile-run:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const summary = await reconcileOrgPendingPayments(session.organizationId);

    // counts only — no payment ids, no PII.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "payments_reconciled",
      entity: "payment",
      details: `scanned:${summary.scanned} completed:${summary.completed} failed:${summary.failed} noop:${summary.noop}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError },
        "Failed to write audit log for reconcile",
      );
    });

    return successResponse(summary);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to reconcile payments");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
