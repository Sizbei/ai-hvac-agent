/**
 * Communication Templates API
 *
 * CRUD operations for communication templates.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { communicationTemplates } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { z } from "zod";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logAudit } from "@/lib/admin/audit";
import { logger } from "@/lib/logger";
import { validateSmsTemplate } from "@/lib/communication/sms-templates";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Validation schema
const templateSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, "Invalid key format"),
  name: z.string().min(1).max(255),
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
  ]),
  templateType: z.enum(["sms", "email_html", "email_text"]),
  subjectTemplate: z.string().optional(),
  bodyTemplate: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
  priority: z.number().min(0).max(100).optional(),
});

/**
 * GET /api/admin/communications/templates
 *
 * List all communication templates for the organization.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:templates-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const templates = await db.query.communicationTemplates.findMany({
      where: eq(communicationTemplates.organizationId, session.organizationId),
      orderBy: [asc(communicationTemplates.triggerType), asc(communicationTemplates.priority)],
    });

    return successResponse({ templates });
  } catch (error) {
    logger.error({ error }, "Failed to fetch communication templates");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

/**
 * POST /api/admin/communications/templates
 *
 * Create a new communication template.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:templates-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body = await request.json();
    const validated = templateSchema.parse(body);

    // Validate template syntax
    if (validated.templateType === "sms") {
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

    // Check if key already exists for this organization
    const existing = await db.query.communicationTemplates.findFirst({
      where: and(
        eq(communicationTemplates.organizationId, session.organizationId),
        eq(communicationTemplates.key, validated.key),
      ),
    });

    if (existing) {
      return errorResponse(
        "Template key already exists",
        "DUPLICATE_KEY",
        409,
      );
    }

    const [created] = await db
      .insert(communicationTemplates)
      .values({
        organizationId: session.organizationId,
        key: validated.key,
        name: validated.name,
        description: validated.description ?? null,
        triggerType: validated.triggerType as any,
        templateType: validated.templateType as any,
        subjectTemplate: validated.subjectTemplate ?? null,
        bodyTemplate: validated.bodyTemplate,
        variables: (validated.variables as any) ?? {},
        isActive: validated.isActive ?? true,
        priority: validated.priority ?? 50,
      })
      .returning();

    // Log audit
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create",
      entity: "communication_template",
      entityId: created.id,
      details: `Created template: ${validated.key}`,
    });

    logger.info(
      { templateId: created.id, key: validated.key, adminId: session.userId },
      "Communication template created",
    );

    return successResponse({ template: created }, 201);
  } catch (error) {
    logger.error({ error }, "Failed to create communication template");

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
