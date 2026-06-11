/**
 * PATCH /api/admin/custom-fields/[id]
 * DELETE /api/admin/custom-fields/[id]
 *
 * Update and delete custom field definitions.
 */

import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { z } from "zod";
import {
  updateFieldDefinition,
  deleteFieldDefinition,
  getFieldDefinitionById,
} from "@/lib/custom-fields";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

// Schema for updating a field definition
const updateFieldSchema = z.object({
  key: z.string().min(1).max(100).optional(),
  label: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  entityType: z.enum(["customer", "service_request", "both"]).optional(),
  fieldType: z.enum(["text", "textarea", "select", "multiselect", "number", "currency", "date", "checkbox"]).optional(),
  options: z.array(z.string().max(255)).optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.any().optional(),
  validation: z.record(z.string(), z.any()).optional(),
  displayOrder: z.number().optional(),
  isActive: z.boolean().optional(),
});

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
      `admin:custom-fields:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const params = await context.params;

    // Verify the field belongs to the session's organization
    const existing = await getFieldDefinitionById(params.id);
    if (!existing || existing.organizationId !== session.organizationId) {
      return errorResponse("Field not found", "NOT_FOUND", 404);
    }

    const body: unknown = await request.json();
    const parsed = updateFieldSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body",
        "VALIDATION_ERROR",
        400,
      );
    }

    const updated = await updateFieldDefinition(params.id, parsed.data);

    return successResponse({ field: updated });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update field definition");
    return errorResponse(
      error instanceof Error ? error.message : "Failed to update field",
      "INTERNAL_ERROR",
      500,
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
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

    const params = await context.params;

    // Verify the field belongs to the session's organization
    const existing = await getFieldDefinitionById(params.id);
    if (!existing || existing.organizationId !== session.organizationId) {
      return errorResponse("Field not found", "NOT_FOUND", 404);
    }

    const deleted = await deleteFieldDefinition(params.id);

    return successResponse({ field: deleted });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to delete field definition");
    return errorResponse(
      error instanceof Error ? error.message : "Failed to delete field",
      "INTERNAL_ERROR",
      500,
    );
  }
}
