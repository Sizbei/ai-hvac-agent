import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getAdminSession } from "@/lib/auth/session";
import { finalizeInvoice } from "@/lib/admin/invoice-field-writes";
import { fieldError } from "@/lib/tech/invoice-errors";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";

export const dynamic = "force-dynamic";

/** Office finalize (spec §8): draft → open so a draft a technician left behind is never stranded. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const rateCheck = slidingWindow(
      `admin:invoice-finalize:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!isUuid(id)) {
      return errorResponse("Invalid ID", "VALIDATION_ERROR", 400);
    }

    const orgId = session.organizationId;
    const [inv] = await db
      .select({ serviceRequestId: invoices.serviceRequestId })
      .from(invoices)
      .where(withTenant(invoices, orgId, eq(invoices.id, id)))
      .limit(1);
    if (!inv) return errorResponse("Invoice not found", "NOT_FOUND", 404);

    const result = await finalizeInvoice(
      { organizationId: orgId, requestId: inv.serviceRequestId ?? null, techUserId: null },
      id,
    );
    if (!result.ok) {
      switch (result.reason) {
        case "invoice_not_found":
          return errorResponse("Invoice not found", "NOT_FOUND", 404);
        case "stale":
          return errorResponse("This invoice changed. Refresh and try again.", "STALE", 409);
        case "no_lines":
        case "invoice_locked":
        case "synced_read_only": {
          const e = fieldError(result.reason);
          return errorResponse(e.message, e.code, e.status);
        }
        default:
          return errorResponse("Could not finalize invoice", "VALIDATION_ERROR", 400);
      }
    }

    if (result.changed) {
      await logAudit({
        organizationId: orgId,
        userId: session.userId,
        action: "invoice_finalized",
        entity: "invoice",
        entityId: id,
        details: `invoiceId:${id}`,
      }).catch((auditError: unknown) => {
        logger.error({ error: auditError, invoiceId: id }, "Failed to write audit log for finalize");
      });
    }

    return successResponse({ invoiceId: id, state: result.state, changed: result.changed });
  } catch (error) {
    logger.error({ error }, "Failed to finalize invoice");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
