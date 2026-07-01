import { NextRequest, after } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { unscheduleRequest } from "@/lib/admin/scheduling-queries";
import { syncRequestToCalendar } from "@/lib/integrations/google-calendar/sync";
import { pushJobToHcp } from "@/lib/integrations/housecall-pro/job-sync";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientIp(request: NextRequest): string {
  const raw = request.headers.get("x-forwarded-for");
  return raw?.split(",")[0]?.trim().slice(0, 45) || "unknown";
}

/**
 * POST /api/admin/requests/[id]/unschedule — drag-back-to-Unscheduled: clear the
 * job's placement (schedule/window/assignee) and return it to the queue. Admin
 * session + adminMutation rate limit + audit, mirroring the reschedule route.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const rateCheck = slidingWindow(
      `admin:request-unschedule:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const result = await unscheduleRequest(session.organizationId, id);
    if (!result.ok) {
      if (result.reason === "request_not_found") {
        return errorResponse("Request not found", "NOT_FOUND", 404);
      }
      return errorResponse(
        `Request cannot be unscheduled while it is '${result.currentStatus}'`,
        "REQUEST_TERMINAL",
        409,
      );
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "request_unscheduled",
      entity: "service_request",
      entityId: id,
      details: JSON.stringify({
        cleared: ["scheduledDate", "arrivalWindow", "assignedTo"],
      }),
      ipAddress: clientIp(request),
    });

    // Mirror the cleared placement outward (idempotent, degrade-safe, no-op when
    // the org isn't connected) — same after() pattern as reschedule.
    after(() => syncRequestToCalendar(session.organizationId, id));
    after(() => pushJobToHcp(session.organizationId, id));

    return successResponse(result);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to unschedule request");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
