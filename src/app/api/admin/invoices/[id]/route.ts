import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getInvoiceDetailById, getInvoiceOrgIdentity } from "@/lib/admin/invoice-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

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
      `admin:invoice-detail:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    const invoice = await getInvoiceDetailById(session.organizationId, id);
    if (!invoice) {
      return errorResponse("Invoice not found", "NOT_FOUND", 404);
    }
    const org = await getInvoiceOrgIdentity(session.organizationId);
    return successResponse({ invoice, org });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch invoice detail");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
