/**
 * Single Communication Template API
 *
 * Operations on individual communication templates.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { communicationTemplates } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logAudit } from "@/lib/admin/audit";
import { logger } from "@/lib/logger";
import { validateSmsTemplate } from "@/lib/communication/sms-templates";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Validation schema for updates
const updateTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  triggerType: z.enum([
    "appointment_scheduled",
    "appointment_reminder_24h",
    "appointment_reminder_2h",
    "appointment_rescheduled",
    "appointment_cancelled",
    "technician_enroute",
    "technician_arrived",
    "job_completed",
    "review_request",
    "follow_up",
    "escalation",
  ]).optional(),
  templateType: z.enum(["sms", "email_html", "email_text"]).optional(),
  subjectTemplate: z.string().optional(),
  bodyTemplate: z.string().min(1).optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
  priority: z.number().min(0).max(100).optional(),
});

/**
 * PATCH /api/admin/communications/templates/[id]
 *
 * Update a communication template.
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

    const rateCheck = slidingWindow(
      `admin:template-mutate:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id: templateId } = await params;

    // Verify template belongs to organization
    const existing = await db.query.communicationTemplates.findFirst({
      where: and(
        eq(communicationTemplates.id, templateId),
        eq(communicationTemplates.organizationId, session.organizationId),
      ),
    });

    if (!existing) {
      return errorResponse("Template not found", "NOT_FOUND", 404);
    }

    const body = await request.json();
    const validated = updateTemplateSchema.parse(body);

    // Validate template syntax if body is being updated
    if (validated.bodyTemplate && existing.templateType === "sms") {
      try {
        validateSmsTemplate(validated.bodyTemplate);
      } catch (error) {
        return errorResponse(
          `Invalid template syntax: ${error instanceof Error ? error.message : "Unknown error"}`,
          "INVALID_TEMPLATE",
          400,
        );
      }
    }

    // Build update object with only provided fields
    const updateData: Record<string, unknown> = {};
    if (validated.name !== undefined) updateData.name = validated.name;
    if (validated.description !== undefined) updateData.description = validated.description;
    if (validated.triggerType !== undefined) updateData.triggerType = validated.triggerType as any;
    if (validated.templateType !== undefined) updateData.templateType = validated.templateType as any;
    if (validated.subjectTemplate !== undefined) updateData.subjectTemplate = validated.subjectTemplate;
    if (validated.bodyTemplate !== undefined) updateData.bodyTemplate = validated.bodyTemplate;
    if (validated.variables !== undefined) updateData.variables = validated.variables;
    if (validated.isActive !== undefined) updateData.isActive = validated.isActive;
    if (validated.priority !== undefined) updateData.priority = validated.priority;
    updateData.updatedAt = new Date();

    const [updated] = await db
      .update(communicationTemplates)
      .set(updateData)
      .where(eq(communicationTemplates.id, templateId))
      .returning();

    // Log audit
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update",
      entity: "communication_template",
      entityId: templateId,
      details: `Updated template: ${existing.key}`,
    });

    logger.info(
      { templateId, key: existing.key, adminId: session.userId },
      "Communication template updated",
    );

    return successResponse({ template: updated });
  } catch (error) {
    logger.error({ error }, "Failed to update communication template");

    if (error instanceof z.ZodError) {
      return errorResponse(
        "Invalid request body",
        "VALIDATION_ERROR",
        400,
        error.issues,
      );
    }

    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

/**
 * DELETE /api/admin/communications/templates/[id]
 *
 * Delete a communication template.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:template-mutate:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id: templateId } = await params;

    // Verify template belongs to organization
    const existing = await db.query.communicationTemplates.findFirst({
      where: and(
        eq(communicationTemplates.id, templateId),
        eq(communicationTemplates.organizationId, session.organizationId),
      ),
    });

    if (!existing) {
      return errorResponse("Template not found", "NOT_FOUND", 404);
    }

    await db
      .delete(communicationTemplates)
      .where(eq(communicationTemplates.id, templateId));

    // Log audit
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "delete",
      entity: "communication_template",
      entityId: templateId,
      details: `Deleted template: ${existing.key}`,
    });

    logger.info(
      { templateId, key: existing.key, adminId: session.userId },
      "Communication template deleted",
    );

    return successResponse({ deleted: true });
  } catch (error) {
    logger.error({ error }, "Failed to delete communication template");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
