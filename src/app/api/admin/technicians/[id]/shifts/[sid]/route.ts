import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { deleteShift, getShift } from "@/lib/admin/shift-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sid: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const rateCheck = slidingWindow(
      `admin:shifts-delete:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const { id, sid } = await params;
    if (!UUID_REGEX.test(id) || !UUID_REGEX.test(sid)) {
      return errorResponse("Shift not found", "NOT_FOUND", 404);
    }

    const existing = await getShift(session.organizationId, id, sid);
    const deleted = await deleteShift(session.organizationId, id, sid);
    if (!deleted) return errorResponse("Shift not found", "NOT_FOUND", 404);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "delete_shift",
      entity: "technician_shifts",
      entityId: sid,
      details: JSON.stringify({
        technicianId: id,
        kind: existing?.kind,
        removesCapacity: existing?.removesCapacity,
      }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit shift deletion");
    });

    return successResponse({ deleted: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to delete shift");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
