/**
 * POST /api/admin/custom-fields
 * GET /api/admin/custom-fields
 *
 * Create and list custom field definitions.
 */

import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { z } from "zod";
import {
  createFieldDefinition,
  getFieldDefinitions,
} from "@/lib/custom-fields";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

// Schema for creating a field definition
const createFieldSchema = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(255),
  description: z.string().optional(),
  entityType: z.enum(["customer", "service_request", "both"]),
  fieldType: z.enum(["text", "textarea", "select", "multiselect", "number", "currency", "date", "checkbox"]),
  options: z.array(z.string().max(255)).optional(),
  required: z.boolean().optional().default(false),
  placeholder: z.string().optional(),
  defaultValue: z.any().optional(),
  validation: z.record(z.string(), z.any()).optional(),
  displayOrder: z.number().optional().default(0),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:custom-fields:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = createFieldSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body",
        "VALIDATION_ERROR",
        400,
      );
    }

    const created = await createFieldDefinition(session.organizationId, parsed.data);

    return successResponse({ field: created }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create field definition");
    return errorResponse(
      error instanceof Error ? error.message : "Failed to create field",
      "INTERNAL_ERROR",
      500,
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { searchParams } = new URL(request.url);
    const entityType = searchParams.get("entityType") as "customer" | "service_request" | null;
    const activeOnly = searchParams.get("active") !== "false";

    const fields = await getFieldDefinitions(
      session.organizationId,
      entityType || undefined,
      activeOnly,
    );

    return successResponse({ fields });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list field definitions");
    return errorResponse(
      "Failed to list fields",
      "INTERNAL_ERROR",
      500,
    );
  }
}
