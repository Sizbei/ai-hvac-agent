import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { sendInvoiceReminder } from "@/lib/communication/money-triggers";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const REASON_STATUS: Record<string, number> = {
  not_found: 404,
  not_collectible: 400,
  no_contact: 400,
  no_template: 400,
  cooldown: 409,
};

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const rateCheck = slidingWindow(
      `admin:invoice-reminder:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    const result = await sendInvoiceReminder(session.organizationId, id);

    if (!result.ok) {
      return errorResponse(
        "Could not send reminder",
        result.reason.toUpperCase(),
        REASON_STATUS[result.reason] ?? 400,
      );
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "invoice.reminder_sent",
      entity: "invoice",
      entityId: id,
    });

    return successResponse({ ok: true });
  } catch (error) {
    logger.error({ error }, "Failed to send invoice reminder");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
