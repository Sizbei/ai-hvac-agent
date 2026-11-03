import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { listAppointments, addAppointment } from "@/lib/admin/appointment-queries";
import { appointmentInputSchema } from "@/lib/admin/appointment-types";
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

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:appointments-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const appointments = await listAppointments(session.organizationId, id);
    if (appointments === null) {
      return errorResponse("Request not found", "NOT_FOUND", 404);
    }
    return successResponse({ appointments });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list visits");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:appointments-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }
    const parsed = appointmentInputSchema.safeParse(body.data);
    if (!parsed.success) {
      return errorResponse(
        "Invalid visit: " + parsed.error.issues[0]?.message,
        "VALIDATION_ERROR",
        400,
      );
    }

    // organizationId comes from the session only; the request must be in it.
    const result = await addAppointment(
      session.organizationId,
      id,
      parsed.data,
      session.userId,
    );
    if ("reason" in result) {
      switch (result.reason) {
        case "request_not_found":
          return errorResponse("Request not found", "NOT_FOUND", 404);
        case "request_cancelled":
          return errorResponse("This request is cancelled.", "REQUEST_CANCELLED", 409);
        case "request_completed":
          return errorResponse("This request is already completed.", "REQUEST_COMPLETED", 409);
        case "technician_not_found":
          return errorResponse(
            "One or more technicians aren't active on your team.",
            "TECHNICIAN_NOT_FOUND",
            400,
          );
        case "conflict":
          return errorResponse("Couldn't add the visit. Try again.", "CONFLICT", 409);
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
      action: "add_appointment",
      entity: "appointments",
      entityId: result.id,
      details: JSON.stringify({
        serviceRequestId: id,
        appointmentNumber: result.appointmentNumber,
        technicianIds: result.assignments.map((a) => a.technicianId),
      }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit visit creation");
    });

    return successResponse({ appointment: result }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to add visit");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
