/**
 * POST /api/admin/custom-field-values
 *
 * Set a custom field value on an entity.
 */

import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { z } from "zod";
import { setFieldValue } from "@/lib/custom-fields";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

// Schema for setting a field value
const setValueSchema = z.object({
  entityType: z.enum(["customer", "service_request"]),
  entityId: z.string().uuid(),
  fieldKey: z.string(),
  value: z.any(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:custom-field-values:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = setValueSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body",
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await setFieldValue(session.organizationId, parsed.data);

    return successResponse({ value: result }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to set field value");
    return errorResponse(
      error instanceof Error ? error.message : "Failed to set value",
      "INTERNAL_ERROR",
      500,
    );
  }
}
