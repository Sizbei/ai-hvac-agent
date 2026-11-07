import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { addVisitTechnician } from "@/lib/admin/assignment-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

type Params = { params: Promise<{ id: string; aid: string }> };

const bodySchema = z.object({ technicianId: z.uuid() });

/** Add a technician (helper) to a visit, including visit #1. Body: { technicianId }. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(
      `admin:visit-technician-add:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const { id, aid } = await params;
    if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(aid).success) {
      return errorResponse("Invalid ID format", "INVALID_ID", 400);
    }
    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const parsed = bodySchema.safeParse(body.data);
    if (!parsed.success) return errorResponse("Choose a technician.", "VALIDATION_ERROR", 400);

    const result = await addVisitTechnician(
      session.organizationId, id, aid, parsed.data.technicianId, session.userId,
    );
    if ("reason" in result) {
      switch (result.reason) {
        case "not_found":
          return errorResponse("Visit not found", "NOT_FOUND", 404);
        case "technician_not_found":
          return errorResponse("That technician isn't active on your team.", "TECHNICIAN_NOT_FOUND", 400);
        case "already_assigned":
          return errorResponse("That technician is already on this visit.", "ALREADY_ASSIGNED", 409);
        case "visit_cancelled":
          return errorResponse("This visit is cancelled.", "VISIT_CANCELLED", 409);
        case "visit_ended":
          return errorResponse("This visit has ended.", "VISIT_ENDED", 409);
        case "request_cancelled":
          return errorResponse("This request is cancelled.", "REQUEST_CANCELLED", 409);
        case "request_completed":
          return errorResponse("This request is completed.", "REQUEST_COMPLETED", 409);
        case "managed_externally":
          return errorResponse("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
        case "time_off":
          return errorResponse("That technician is off during this visit.", "TIME_OFF", 409);
        case "no_lead":
          return errorResponse("Assign a technician to this request first.", "NO_LEAD", 409);
        case "visit_full":
          return errorResponse("This visit already has 5 technicians.", "VISIT_FULL", 409);
      }
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "add_visit_technician",
      entity: "appointments",
      entityId: aid,
      details: JSON.stringify({
        serviceRequestId: id,
        appointmentNumber: result.appointmentNumber,
        technicianId: parsed.data.technicianId,
      }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit visit technician add");
    });

    return successResponse({ appointment: result }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to add visit technician");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
