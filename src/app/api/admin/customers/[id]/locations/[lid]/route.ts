import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { setPrimaryLocation } from "@/lib/admin/location-queries";
import { logAudit } from "@/lib/admin/audit";
import { isUuid } from "@/lib/validation/uuid";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string; lid: string }>;
}

const patchSchema = z.object({ isPrimary: z.literal(true) });

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:customer-location-primary:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id, lid } = await params;
    if (!isUuid(id) || !isUuid(lid)) {
      return errorResponse("Not found", "NOT_FOUND", 404);
    }

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      return errorResponse("Invalid JSON body", "VALIDATION_ERROR", 400);
    }
    const parsed = patchSchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return errorResponse("Only isPrimary: true is supported.", "VALIDATION_ERROR", 400);
    }

    const result = await setPrimaryLocation(session.organizationId, id, lid);
    if (result === false) {
      return errorResponse("Location not found", "NOT_FOUND", 404);
    }
    if (typeof result === "object") {
      return errorResponse(
        "Someone else just changed the primary location. Reload and try again.",
        "CONFLICT",
        409,
      );
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "set_primary_location",
      entity: "customer_locations",
      entityId: lid,
      details: JSON.stringify({ customerId: id }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit set_primary_location");
    });

    return successResponse({ id: lid, isPrimary: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to set primary location");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
