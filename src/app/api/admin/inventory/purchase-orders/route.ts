import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  createPurchaseOrder,
  listPurchaseOrders,
} from "@/lib/admin/inventory-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const lineSchema = z.object({
  pricebookItemId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1).max(255),
  quantity: z.number().int().min(1),
  unitCostCents: z.number().int().min(0),
});

const createSchema = z.object({
  vendorName: z.string().trim().min(1).max(255),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(lineSchema).min(1).max(200),
});

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:po-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const purchaseOrders = await listPurchaseOrders(session.organizationId);
    return successResponse({ purchaseOrders });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch purchase orders");
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
      `admin:po-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid purchase order", "VALIDATION_ERROR", 400);
    }

    const id = await createPurchaseOrder(session.organizationId, parsed.data);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_purchase_order",
      entity: "purchase_order",
      entityId: id,
      details: `lines=${parsed.data.lines.length}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, poId: id },
        "Failed to write audit log for purchase order creation",
      );
    });

    return successResponse({ id }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create purchase order");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
