import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { removeVisitTechnician } from "@/lib/admin/assignment-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

type Params = { params: Promise<{ id: string; aid: string; tid: string }> };

/** Remove a helper from a visit. Refused for the lead, for anyone with progress, and on a synced, completed or cancelled request. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(
      `admin:visit-technician-remove:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const { id, aid, tid } = await params;
    if (![id, aid, tid].every((v) => z.uuid().safeParse(v).success)) {
      return errorResponse("Invalid ID format", "INVALID_ID", 400);
    }

    const result = await removeVisitTechnician(session.organizationId, id, aid, tid);
    if ("reason" in result) {
      switch (result.reason) {
        case "not_found":
          return errorResponse("That technician isn't on this visit.", "NOT_FOUND", 404);
        case "has_progress":
          return errorResponse("That technician has already started on this visit.", "HAS_PROGRESS", 409);
        case "is_lead":
          return errorResponse("Change the lead from the visit instead.", "IS_LEAD", 409);
        case "managed_externally":
          return errorResponse("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
        case "request_completed":
          return errorResponse("This request is completed.", "REQUEST_COMPLETED", 409);
        case "request_cancelled":
          return errorResponse("This request is cancelled.", "REQUEST_CANCELLED", 409);
      }
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "remove_visit_technician",
      entity: "appointments",
      entityId: aid,
      details: JSON.stringify({ serviceRequestId: id, technicianId: tid }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit visit technician removal");
    });

    return successResponse({ removed: true, cancelled: result.cancelled });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to remove visit technician");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
