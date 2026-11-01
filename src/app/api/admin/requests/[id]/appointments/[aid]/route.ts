import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { updateAppointment, cancelAppointment } from "@/lib/admin/appointment-queries";
import { appointmentPatchSchema, appointmentCancelSchema } from "@/lib/admin/appointment-types";
import { logAudit } from "@/lib/admin/audit";
import {
  successResponse,
  errorResponse,
  readJsonBody,
} from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ id: string; aid: string }> };

const VERSION_CONFLICT = ["This visit changed. Reload and try again.", "VERSION_CONFLICT", 409] as const;
const IS_FIRST_VISIT = ["Edit the first visit from the request itself.", "IS_FIRST_VISIT", 409] as const;
const NOT_FOUND = ["Visit not found", "NOT_FOUND", 404] as const;

async function guard(request: NextRequest, params: Params["params"], bucket: string) {
  const session = await getAdminSession();
  if (!session) {
    return { error: errorResponse("Unauthorized", "UNAUTHORIZED", 401) } as const;
  }
  const rateCheck = slidingWindow(
    `admin:${bucket}:${session.userId}`,
    RATE_LIMITS.adminMutation.maxRequests,
    RATE_LIMITS.adminMutation.windowMs,
  );
  if (!rateCheck.allowed) {
    return { error: errorResponse("Rate limit exceeded", "RATE_LIMITED", 429) } as const;
  }
  const { id, aid } = await params;
  if (!UUID_REGEX.test(id) || !UUID_REGEX.test(aid)) {
    return { error: errorResponse("Invalid ID format", "INVALID_ID", 400) } as const;
  }
  const body = await readJsonBody(request);
  if (!body.ok) {
    return { error: errorResponse("Invalid request body", "VALIDATION_ERROR", 400) } as const;
  }
  return { session, id, aid, data: body.data } as const;
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const g = await guard(request, params, "appointments-update");
    if ("error" in g) return g.error;
    const { session, id, aid } = g;

    const parsed = appointmentPatchSchema.safeParse(g.data);
    if (!parsed.success) {
      return errorResponse(
        "Invalid visit: " + parsed.error.issues[0]?.message,
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await updateAppointment(
      session.organizationId,
      id,
      aid,
      parsed.data,
      session.userId,
    );
    if ("reason" in result) {
      switch (result.reason) {
        case "not_found":
          return errorResponse(...NOT_FOUND);
        case "is_first_visit":
          return errorResponse(...IS_FIRST_VISIT);
        case "version_conflict":
          return errorResponse(...VERSION_CONFLICT);
        case "request_cancelled":
          return errorResponse("This request is cancelled.", "REQUEST_CANCELLED", 409);
        case "visit_cancelled":
          return errorResponse("This visit is cancelled.", "VISIT_CANCELLED", 409);
        case "technician_not_found":
          return errorResponse(
            "One or more technicians aren't active on your team.",
            "TECHNICIAN_NOT_FOUND",
            400,
          );
        case "time_off":
          return errorResponse(
            "One of those technicians is off during this window.",
            "TIME_OFF",
            409,
          );
      }
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update_appointment",
      entity: "appointments",
      entityId: aid,
      details: JSON.stringify({
        serviceRequestId: id,
        appointmentNumber: result.appointmentNumber,
        technicianIds: result.assignments.map((a) => a.technicianId),
      }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit visit update");
    });

    return successResponse({ appointment: result });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update visit");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

/** Cancel a visit (#2+). Body: { version }. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const g = await guard(request, params, "appointments-cancel");
    if ("error" in g) return g.error;
    const { session, id, aid } = g;

    const parsed = appointmentCancelSchema.safeParse(g.data);
    if (!parsed.success) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }

    const result = await cancelAppointment(
      session.organizationId,
      id,
      aid,
      parsed.data.version,
    );
    if ("reason" in result) {
      switch (result.reason) {
        case "not_found":
          return errorResponse(...NOT_FOUND);
        case "is_first_visit":
          return errorResponse(...IS_FIRST_VISIT);
        case "version_conflict":
          return errorResponse(...VERSION_CONFLICT);
      }
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "cancel_appointment",
      entity: "appointments",
      entityId: aid,
      details: JSON.stringify({
        serviceRequestId: id,
        appointmentNumber: result.appointmentNumber,
      }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit visit cancellation");
    });

    return successResponse({ cancelled: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to cancel visit");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
