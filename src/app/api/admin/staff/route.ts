import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { listStaff, createStaff } from "@/lib/admin/staff-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:staff-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const staff = await listStaff(session.organizationId);
    // Echo the caller's own id so the UI can disable self-demote/self-deactivate
    // without a second round-trip. (The server enforces this regardless.)
    return successResponse({ staff, currentUserId: session.userId });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list staff");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

const createStaffSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
  role: z.enum(["admin", "technician"]),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:staff-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = createStaffSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body: name, valid email, password (min 8 chars), and a valid role required",
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await createStaff(
      session.organizationId,
      parsed.data,
      session.role,
    );
    if (!result.ok) {
      if (result.reason === "forbidden") {
        return errorResponse(
          "Only a super admin can create admin accounts",
          "FORBIDDEN",
          403,
        );
      }
      return errorResponse(
        "A user with this email already exists in your organization",
        "EMAIL_CONFLICT",
        409,
      );
    }

    const ipAddress = clientIp(request);
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_staff",
      entity: "user",
      entityId: result.staff.id,
      // Enum only — never the name, email, or password. role is a permitted
      // enum value; the audit viewer renders `details` verbatim.
      details: JSON.stringify({ role: result.staff.role }),
      ipAddress,
    });

    return successResponse(result.staff, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create staff member");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
