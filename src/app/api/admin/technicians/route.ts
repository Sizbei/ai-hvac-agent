import { getAdminSession } from "@/lib/auth/session";
import { getViewerContext } from "@/lib/auth/viewer";
import { PLATFORM_PROTECTED_MESSAGE } from "@/lib/admin/staff-errors";
import { getTechnicians, createTechnician } from "@/lib/admin/queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { z } from "zod";

export async function GET() {
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { session } = viewer;

    const rateCheck = slidingWindow(
      `admin:technicians-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const technicians = await getTechnicians(session.organizationId, viewer);
    return successResponse({ technicians });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch technicians");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

const createTechnicianSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

export async function POST(request: Request) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:technicians-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = createTechnicianSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body: name required, valid email required, password min 8 chars",
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await createTechnician(
      session.organizationId,
      parsed.data,
      session,
    );
    if (!result.ok) {
      if (result.reason === "platform_protected") {
        return errorResponse(
          PLATFORM_PROTECTED_MESSAGE,
          "PLATFORM_PROTECTED",
          403,
        );
      }
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }
    const { technician } = result;

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_technician",
      entity: "user",
      entityId: technician.id,
    });

    return successResponse(technician, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create technician");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
