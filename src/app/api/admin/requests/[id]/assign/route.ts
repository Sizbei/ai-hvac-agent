import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { assignTechnician, reassignTechnician } from "@/lib/admin/queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";
import { z } from "zod";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const assignSchema = z.object({
  technicianId: z.string().uuid(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;

    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const rateCheck = slidingWindow(
      `admin:request-assign:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = assignSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body: technicianId must be a valid UUID",
        "VALIDATION_ERROR",
        400,
      );
    }

    const { technicianId } = parsed.data;

    const result = await assignTechnician(
      session.organizationId,
      id,
      technicianId,
    );

    if (!result.ok) {
      switch (result.reason) {
        case "technician_not_found":
          return errorResponse(
            "Technician not found, not active, or not a technician",
            "TECHNICIAN_NOT_FOUND",
            404,
          );
        case "request_not_found":
          return errorResponse("Request not found", "NOT_FOUND", 404);
        case "request_not_assignable":
          return errorResponse(
            `Request cannot be assigned while it is '${result.currentStatus}'`,
            "REQUEST_NOT_ASSIGNABLE",
            409,
          );
      }
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "assign_technician",
      entity: "service_request",
      entityId: id,
      details: JSON.stringify({ technicianId }),
      ipAddress: clientIp(request),
    });

    return successResponse(result.request);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to assign technician");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

/**
 * Reassign an in-flight request (assigned/in_progress) to a different
 * technician WITHOUT resetting its lifecycle. POST is the initial assignment
 * (pending → assigned); PATCH swaps the assignee while preserving status.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const rateCheck = slidingWindow(
      `admin:request-reassign:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = assignSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body: technicianId must be a valid UUID",
        "VALIDATION_ERROR",
        400,
      );
    }

    const { technicianId } = parsed.data;

    const result = await reassignTechnician(
      session.organizationId,
      id,
      technicianId,
    );

    if (!result.ok) {
      switch (result.reason) {
        case "technician_not_found":
          return errorResponse(
            "Technician not found, not active, or not a technician",
            "TECHNICIAN_NOT_FOUND",
            404,
          );
        case "request_not_found":
          return errorResponse("Request not found", "NOT_FOUND", 404);
        case "request_not_reassignable":
          return errorResponse(
            `Request cannot be reassigned while it is '${result.currentStatus}'`,
            "REQUEST_NOT_REASSIGNABLE",
            409,
          );
      }
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "reassign_technician",
      entity: "service_request",
      entityId: id,
      // technicianId is a non-PII id, safe to record verbatim.
      details: JSON.stringify({ technicianId }),
      ipAddress: clientIp(request),
    });

    return successResponse(result.request);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to reassign technician");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
