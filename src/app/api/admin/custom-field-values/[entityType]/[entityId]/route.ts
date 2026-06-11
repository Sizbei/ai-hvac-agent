/**
 * GET /api/admin/custom-field-values/[entityType]/[entityId]
 *
 * Get all custom field values for an entity.
 */

import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getFieldValues } from "@/lib/custom-fields";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ entityType: string; entityId: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const params = await context.params;
    const entityType = params.entityType as "customer" | "service_request";
    if (entityType !== "customer" && entityType !== "service_request") {
      return errorResponse("Invalid entity type", "VALIDATION_ERROR", 400);
    }

    const values = await getFieldValues(
      session.organizationId,
      entityType,
      params.entityId,
    );

    return successResponse({ values });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to get field values");
    return errorResponse(
      "Failed to get values",
      "INTERNAL_ERROR",
      500,
    );
  }
}
