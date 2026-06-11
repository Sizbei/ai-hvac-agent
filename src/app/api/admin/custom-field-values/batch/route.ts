/**
 * POST /api/admin/custom-field-values/batch
 *
 * Set multiple custom field values at once.
 */

import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { z } from "zod";
import { batchSetFieldValues } from "@/lib/custom-fields";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

// Schema for batch setting values
const batchSetSchema = z.object({
  entityType: z.enum(["customer", "service_request"]),
  entityId: z.string().uuid(),
  values: z.record(z.string(), z.any()),
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
    const parsed = batchSetSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body",
        "VALIDATION_ERROR",
        400,
      );
    }

    const results = await batchSetFieldValues(session.organizationId, parsed.data);

    return successResponse({ values: results }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to batch set field values");
    return errorResponse(
      error instanceof Error ? error.message : "Failed to set values",
      "INTERNAL_ERROR",
      500,
    );
  }
}
