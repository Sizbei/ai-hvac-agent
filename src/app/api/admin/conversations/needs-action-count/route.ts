import { getAdminSession } from "@/lib/auth/session";
import { buildNeedsActionCountQuery } from "@/lib/admin/conversation-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * GET /api/admin/conversations/needs-action-count — conversations that need
 * action (the inbox's "Needs action" filter, same query). Backs the
 * Conversations nav badge; tenant-scoped COUNT(*).
 */
export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:needs-action-count:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const [row] = await buildNeedsActionCountQuery(session.organizationId);
    // neon-http may hand count() back as a string.
    return successResponse({ count: Number(row?.value ?? 0) });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to count conversations needing action");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
