import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  getTaxRateById,
  updateTaxRate,
  deactivateTaxRate,
} from "@/lib/admin/pricebook-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  jurisdiction: z.string().nullable().optional(),
  rateBps: z.number().int().min(0).max(10000).optional(),
  isDefault: z.boolean().optional(),
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
      `admin:tax-rates-update:${session.userId}`,
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
    const existing = await getTaxRateById(session.organizationId, id);
    if (!existing) {
      return errorResponse("Tax rate not found", "NOT_FOUND", 404);
    }

    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid tax rate", "VALIDATION_ERROR", 400);
    }
    if (Object.keys(parsed.data).length === 0) {
      return errorResponse("No fields to update", "VALIDATION_ERROR", 400);
    }

    await updateTaxRate(session.organizationId, id, parsed.data);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update_tax_rate",
      entity: "tax_rate",
      entityId: id,
      details: Object.keys(parsed.data).sort().join(","),
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, taxRateId: id },
        "Failed to write audit log for tax rate update",
      );
    });

    return successResponse({ id });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return errorResponse(
        "A default tax rate already exists",
        "TAX_RATE_CONFLICT",
        409,
      );
    }
    logger.error({ error }, "Failed to update tax rate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:tax-rates-delete:${session.userId}`,
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
    const existing = await getTaxRateById(session.organizationId, id);
    if (!existing) {
      return errorResponse("Tax rate not found", "NOT_FOUND", 404);
    }

    await deactivateTaxRate(session.organizationId, id);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "deactivate_tax_rate",
      entity: "tax_rate",
      entityId: id,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, taxRateId: id },
        "Failed to write audit log for tax rate deactivation",
      );
    });

    return successResponse({ id });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to deactivate tax rate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
