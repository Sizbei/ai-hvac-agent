import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  getPurchaseOrder,
  markPurchaseOrderOrdered,
  receivePurchaseOrder,
} from "@/lib/admin/inventory-queries";
import { getVendorProvider } from "@/lib/inventory/vendor-provider";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const actionSchema = z.object({
  action: z.enum(["order", "receive"]),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:po-get:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    const purchaseOrder = await getPurchaseOrder(session.organizationId, id);
    if (!purchaseOrder) {
      return errorResponse("Purchase order not found", "NOT_FOUND", 404);
    }
    return successResponse({ purchaseOrder });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch purchase order");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

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
      `admin:po-update:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid action", "VALIDATION_ERROR", 400);
    }

    if (parsed.data.action === "order") {
      // Submit through the vendor seam (mock by default — no real order placed),
      // then flip the PO to "ordered".
      const po = await getPurchaseOrder(session.organizationId, id);
      if (!po) {
        return errorResponse("Purchase order not found", "NOT_FOUND", 404);
      }
      const vendor = getVendorProvider();
      const submit = await vendor.submitOrder({
        purchaseOrderId: id,
        vendorName: po.vendorName,
        lines: po.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitCostCents: l.unitCostCents,
        })),
      });
      if (submit.status !== "submitted") {
        return errorResponse("Vendor submission failed", "VENDOR_ERROR", 502);
      }

      const result = await markPurchaseOrderOrdered(session.organizationId, id);
      if (!result.ok) {
        return result.reason === "not_found"
          ? errorResponse("Purchase order not found", "NOT_FOUND", 404)
          : errorResponse(
              "Only a draft purchase order can be ordered",
              "INVALID_STATUS",
              409,
            );
      }

      await logAudit({
        organizationId: session.organizationId,
        userId: session.userId,
        action: "order_purchase_order",
        entity: "purchase_order",
        entityId: id,
        details: `provider=${vendor.name}`,
      }).catch((auditError: unknown) => {
        logger.error(
          { error: auditError, poId: id },
          "Failed to write audit log for purchase order order",
        );
      });

      return successResponse({ id, status: "ordered" });
    }

    // receive
    const result = await receivePurchaseOrder(session.organizationId, id);
    if (!result.ok) {
      return result.reason === "not_found"
        ? errorResponse("Purchase order not found", "NOT_FOUND", 404)
        : errorResponse(
            "Purchase order already received",
            "ALREADY_RECEIVED",
            409,
          );
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "receive_purchase_order",
      entity: "purchase_order",
      entityId: id,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, poId: id },
        "Failed to write audit log for purchase order receipt",
      );
    });

    return successResponse({ id, status: "received" });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update purchase order");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
