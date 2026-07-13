import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  getEstimateDetailById,
  markEstimateSold,
} from "@/lib/admin/estimate-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";

const patchSchema = z.object({
  optionId: z.string().uuid(),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:estimate-detail:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    if (!isUuid(id)) {
      return errorResponse("Not found", "NOT_FOUND", 404);
    }
    const estimate = await getEstimateDetailById(session.organizationId, id);
    if (!estimate) {
      return errorResponse("Estimate not found", "NOT_FOUND", 404);
    }
    return successResponse({ estimate });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch estimate detail");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:estimate-sold:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    if (!isUuid(id)) {
      return errorResponse("Invalid ID", "VALIDATION_ERROR", 400);
    }
    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid request", "VALIDATION_ERROR", 400);
    }

    const result = await markEstimateSold(
      session.organizationId,
      id,
      parsed.data.optionId,
    );

    if (!result.ok) {
      switch (result.reason) {
        case "synced_read_only":
          return errorResponse(
            "This estimate is synced from FieldPulse — status is managed there",
            "SYNCED_READ_ONLY",
            409,
          );
        case "not_found":
          return errorResponse("Estimate not found", "NOT_FOUND", 404);
        case "already_decided":
          return errorResponse(
            "This estimate has already been decided",
            "ALREADY_DECIDED",
            409,
          );
        case "invalid_option":
          return errorResponse(
            "That option does not belong to this estimate",
            "INVALID_OPTION",
            400,
          );
        default:
          return errorResponse("Could not mark sold", "VALIDATION_ERROR", 400);
      }
    }

    // ids/enums only — no signature name or customer PII.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "estimate_marked_sold",
      entity: "estimate",
      entityId: id,
      details: `optionId:${parsed.data.optionId}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, estimateId: id },
        "Failed to write audit log for estimate mark-sold",
      );
    });

    return successResponse({ estimateId: id });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to mark estimate sold");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
