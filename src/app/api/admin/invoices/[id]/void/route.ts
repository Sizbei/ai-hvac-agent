import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { voidInvoice } from "@/lib/admin/invoice-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const REASON_STATUS: Record<string, number> = {
  not_found: 404,
  synced_read_only: 409,
  not_voidable: 409,
  has_payments: 409,
};

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const rateCheck = slidingWindow(
      `admin:invoice-void:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    const result = await voidInvoice(session.organizationId, id);

    if (!result.ok) {
      return errorResponse(
        "Could not void invoice",
        result.reason.toUpperCase(),
        REASON_STATUS[result.reason] ?? 400,
      );
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "invoice.voided",
      entity: "invoice",
      entityId: id,
    });

    return successResponse({ ok: true });
  } catch (error) {
    logger.error({ error }, "Failed to void invoice");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
