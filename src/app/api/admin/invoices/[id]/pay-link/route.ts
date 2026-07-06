import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getInvoiceCustomerId } from "@/lib/admin/invoice-queries";
import { generatePortalToken } from "@/lib/portal/portal-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const rateCheck = slidingWindow(
      `admin:invoice-pay-link:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    const invoiceInfo = await getInvoiceCustomerId(session.organizationId, id);
    if (!invoiceInfo || !invoiceInfo.customerId) {
      return errorResponse("Invoice not found", "NOT_FOUND", 404);
    }
    if (invoiceInfo.syncedSource !== null) {
      return errorResponse("Synced invoices are read-only", "SYNCED_READONLY", 409);
    }

    const token = await generatePortalToken(session.organizationId, invoiceInfo.customerId);
    if (!token) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
    }

    const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
    const payLink = `${base}/portal/${token}`;

    return successResponse({ payLink });
  } catch (error) {
    logger.error({ error }, "Failed to generate pay link");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
