import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { resetStaffPassword } from "@/lib/admin/staff-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(200),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid user ID format", "INVALID_ID", 400);
    }

    const rateCheck = slidingWindow(
      `admin:staff-reset-pw:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = resetPasswordSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body: password (min 8 chars) required",
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await resetStaffPassword(
      session.organizationId,
      id,
      parsed.data.password,
      session.role,
    );
    if (!result.ok) {
      if (result.reason === "forbidden") {
        return errorResponse(
          "Only a super admin can reset an admin's password",
          "FORBIDDEN",
          403,
        );
      }
      return errorResponse("User not found", "NOT_FOUND", 404);
    }

    const ipAddress = clientIp(request);
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "reset_staff_password",
      entity: "user",
      entityId: id,
      // NO password material in the audit trail — the action name alone says
      // what happened; the new password is never logged or returned.
      ipAddress,
    });

    return successResponse({ id });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to reset staff password");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
