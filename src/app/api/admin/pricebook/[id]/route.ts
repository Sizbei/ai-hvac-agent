import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  getPricebookItemById,
  updatePricebookItem,
  deactivatePricebookItem,
} from "@/lib/admin/pricebook-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";

/** The partial unique index name for org+SKU combos. */
const SKU_CONSTRAINT = "pricebook_items_org_sku_unique";

/** Business cap: $999,999.99 = 99,999,999 cents. */
const MAX_PRICE_CENTS = 99_999_999;

const updateSchema = z
  .object({
    categoryId: z.string().uuid().nullable().optional(),
    type: z.enum(["service", "material", "equipment"]).optional(),
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().nullable().optional(),
    sku: z.string().nullable().optional(),
    costCents: z.number().int().min(0).max(MAX_PRICE_CENTS).optional(),
    markupPct: z.number().int().min(0).max(1000).optional(),
    priceCents: z.number().int().min(0).max(MAX_PRICE_CENTS).optional(),
    memberPriceCents: z.number().int().min(0).max(MAX_PRICE_CENTS).nullable().optional(),
    hours: z.number().int().min(0).nullable().optional(),
    warranty: z.string().nullable().optional(),
  })
  .refine(
    (v) => {
      // Only enforce when BOTH fields are present in this PATCH payload.
      if (v.memberPriceCents == null || v.priceCents == null) return true;
      return v.memberPriceCents <= v.priceCents;
    },
    { message: "Member price must be ≤ standard price" },
  );

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
      `admin:pricebook-update:${session.userId}`,
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
    const existing = await getPricebookItemById(session.organizationId, id);
    if (!existing || existing.organizationId !== session.organizationId) {
      return errorResponse("Item not found", "NOT_FOUND", 404);
    }

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      return errorResponse("Invalid JSON body", "VALIDATION_ERROR", 400);
    }
    const parsed = updateSchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return errorResponse("Invalid pricebook item", "VALIDATION_ERROR", 400);
    }
    if (Object.keys(parsed.data).length === 0) {
      return errorResponse("No fields to update", "VALIDATION_ERROR", 400);
    }

    await updatePricebookItem(session.organizationId, id, parsed.data);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update_pricebook_item",
      entity: "pricebook_item",
      entityId: id,
      details: Object.keys(parsed.data).sort().join(","),
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, itemId: id },
        "Failed to write audit log for pricebook item update",
      );
    });

    return successResponse({ id });
  } catch (error: unknown) {
    if (isUniqueViolation(error, SKU_CONSTRAINT)) {
      return errorResponse(
        "An item with this SKU already exists",
        "ITEM_ALREADY_EXISTS",
        409,
      );
    }
    logger.error({ error }, "Failed to update pricebook item");
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
      `admin:pricebook-delete:${session.userId}`,
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
    const existing = await getPricebookItemById(session.organizationId, id);
    if (!existing || existing.organizationId !== session.organizationId) {
      return errorResponse("Item not found", "NOT_FOUND", 404);
    }

    await deactivatePricebookItem(session.organizationId, id);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "deactivate_pricebook_item",
      entity: "pricebook_item",
      entityId: id,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, itemId: id },
        "Failed to write audit log for pricebook item deactivation",
      );
    });

    return successResponse({ id });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to deactivate pricebook item");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
