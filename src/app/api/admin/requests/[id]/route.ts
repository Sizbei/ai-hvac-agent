import { getAdminSession } from "@/lib/auth/session";
import {
  getRequestById,
  updateRequestStatus,
  scheduleRequest,
} from "@/lib/admin/queries";
import { MANUAL_TARGET_STATUSES } from "@/lib/admin/request-status";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { z } from "zod";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A PATCH can set a status transition, a scheduled date, or both. At least one
// must be present. `scheduledDate` accepts an ISO datetime or null (to clear).
const patchSchema = z
  .object({
    status: z
      .enum([...MANUAL_TARGET_STATUSES] as [string, ...string[]])
      .optional(),
    scheduledDate: z.string().datetime().nullable().optional(),
  })
  .refine(
    (v) => v.status !== undefined || v.scheduledDate !== undefined,
    { message: "Provide a status and/or scheduledDate" },
  );

export async function GET(
  _request: Request,
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

    const detail = await getRequestById(session.organizationId, id);
    if (!detail) {
      return errorResponse("Request not found", "NOT_FOUND", 404);
    }

    return successResponse(detail);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch request detail");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function PATCH(
  request: Request,
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
      `admin:request-patch:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        parsed.error.issues[0]?.message ?? "Invalid request body",
        "VALIDATION_ERROR",
        400,
      );
    }

    // Apply the status transition FIRST — it's the failure-prone, race-guarded
    // step (a concurrent dispatcher can reject it with 409). Doing it first
    // means a partial failure leaves "status unchanged, schedule unchanged"
    // rather than "schedule committed but status rejected" — the latter would
    // silently persist a write while returning an error. The two writes are not
    // transactional (neon-http), so ordering is our only lever here.
    if (parsed.data.status !== undefined) {
      const result = await updateRequestStatus(
        session.organizationId,
        id,
        parsed.data.status as (typeof MANUAL_TARGET_STATUSES)[number],
      );
      if (!result.ok) {
        if (result.reason === "request_not_found") {
          return errorResponse("Request not found", "NOT_FOUND", 404);
        }
        return errorResponse(
          `Cannot change status to '${parsed.data.status}' from '${result.currentStatus}'`,
          "INVALID_TRANSITION",
          409,
        );
      }
      await logAudit({
        organizationId: session.organizationId,
        userId: session.userId,
        action: "request_status_changed",
        entity: "service_request",
        entityId: id,
        details: JSON.stringify({ status: result.status }),
      });
    }

    if (parsed.data.scheduledDate !== undefined) {
      const when = parsed.data.scheduledDate
        ? new Date(parsed.data.scheduledDate)
        : null;
      const result = await scheduleRequest(session.organizationId, id, when);
      if (!result.ok) {
        return errorResponse("Request not found", "NOT_FOUND", 404);
      }
      await logAudit({
        organizationId: session.organizationId,
        userId: session.userId,
        action: "request_scheduled",
        entity: "service_request",
        entityId: id,
        details: JSON.stringify({ scheduledDate: result.scheduledDate }),
      });
    }

    const detail = await getRequestById(session.organizationId, id);
    if (!detail) {
      return errorResponse("Request not found", "NOT_FOUND", 404);
    }
    return successResponse(detail);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update request");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
