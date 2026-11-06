import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  listInventory,
  listTrackedPricebookItemIds,
  createInventoryItem,
  updateInventoryItem,
  type InventorySortKey,
} from "@/lib/admin/inventory-queries";
import { getPricebookItemById } from "@/lib/admin/pricebook-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const upsertSchema = z.object({
  pricebookItemId: z.string().uuid(),
  quantityOnHand: z.number().int().min(0).optional(),
  reorderPoint: z.number().int().min(0).nullable().optional(),
  unitCostCents: z.number().int().min(0).optional(),
  location: z.string().trim().max(255).nullable().optional(),
  // "Track material" omits this (insert-only); "Edit stock" sends true.
  update: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:inventory-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const sp = request.nextUrl.searchParams;

    const rawPage = Number(sp.get("page") ?? "1");
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;

    const rawLimit = Number(sp.get("limit") ?? "50");
    const limit = Number.isFinite(rawLimit) ? Math.min(1000, Math.max(1, Math.floor(rawLimit))) : 50;

    const search = sp.get("search") ?? undefined;
    const belowReorder = sp.get("belowReorder") === "true";

    const VALID_SORT_KEYS: ReadonlyArray<InventorySortKey> = ['name', 'qty_asc', 'qty_desc'];
    const rawSort = sp.get("sort") ?? undefined;
    const sort = rawSort !== undefined && (VALID_SORT_KEYS as readonly string[]).includes(rawSort)
      ? (rawSort as InventorySortKey)
      : undefined;

    const [{ items, total }, trackedPricebookItemIds] = await Promise.all([
      listInventory(session.organizationId, { page, limit, search, belowReorder, sort }),
      listTrackedPricebookItemIds(session.organizationId),
    ]);
    return successResponse({ items, total, trackedPricebookItemIds });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch inventory");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:inventory-upsert:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const parsed = upsertSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid inventory item", "VALIDATION_ERROR", 400);
    }

    // The material must be a real, org-owned pricebook item (the FK + tenant
    // guard prevents linking inventory to another tenant's catalog).
    const item = await getPricebookItemById(
      session.organizationId,
      parsed.data.pricebookItemId,
    );
    if (!item) {
      return errorResponse("Pricebook item not found", "NOT_FOUND", 404);
    }

    const { pricebookItemId, update, ...fields } = parsed.data;
    if (update) {
      const updated = await updateInventoryItem(session.organizationId, pricebookItemId, fields);
      if (!updated) {
        return errorResponse("This material isn't tracked yet.", "NOT_FOUND", 404);
      }
    } else {
      // Insert-only: tracking a material that already has a stock row must
      // never overwrite its on-hand count, reorder point or cost.
      const created = await createInventoryItem(session.organizationId, pricebookItemId, fields);
      if (!created) {
        return errorResponse(
          "This material is already tracked. Edit its row in the list instead.",
          "ALREADY_TRACKED",
          409,
        );
      }
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: update ? "update_inventory_item" : "create_inventory_item",
      entity: "inventory_item",
      entityId: pricebookItemId,
      details: Object.keys(fields).sort().join(","),
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, pricebookItemId },
        "Failed to write audit log for inventory upsert",
      );
    });

    return successResponse({ pricebookItemId }, update ? 200 : 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to upsert inventory item");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
