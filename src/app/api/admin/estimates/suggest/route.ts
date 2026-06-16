import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { suggestEstimateLineItems } from "@/lib/ai/estimate-suggester";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

// Admin-only: SUGGESTS pricebook lines for a request. It returns suggestions
// ONLY — it never creates an estimate and never emits pricing to a customer.
const suggestSchema = z.object({
  serviceRequestId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    // adminMutation tier — an LLM call is expensive, so rate-limit it like a write.
    const rateCheck = slidingWindow(
      `admin:estimate-suggest:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const parsed = suggestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid request", "VALIDATION_ERROR", 400);
    }

    const { suggestions, note } = await suggestEstimateLineItems(
      session.organizationId,
      { serviceRequestId: parsed.data.serviceRequestId },
    );

    // PII-free: record only the request id + how many lines were suggested.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "estimate_suggested",
      entity: "service_request",
      entityId: parsed.data.serviceRequestId,
      details: `count=${suggestions.length}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, serviceRequestId: parsed.data.serviceRequestId },
        "Failed to write audit log for estimate suggestion",
      );
    });

    return successResponse({ suggestions, note });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to suggest estimate line items");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
