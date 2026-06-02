import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { updateStaff } from "@/lib/admin/staff-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const updateStaffSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    role: z.enum(["admin", "technician"]).optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined || v.role !== undefined || v.isActive !== undefined,
    { message: "At least one of name, role, or isActive is required" },
  );

export async function PATCH(request: NextRequest, { params }: RouteParams) {
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
      `admin:staff-update:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = updateStaffSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body: name, role ('admin'|'technician'), or isActive expected",
        "VALIDATION_ERROR",
        400,
      );
    }

    // Self-mutation guard: an admin may rename themselves, but must NOT demote
    // or deactivate their own account through this surface. This is a stricter,
    // per-actor check that fires even when other admins exist — it prevents an
    // admin from accidentally locking THEMSELVES out mid-session. (The
    // org-wide last-admin invariant in updateStaff is the backstop for the
    // case where they target a different admin who happens to be the last one.)
    if (id === session.userId) {
      const demotesSelf = parsed.data.role !== undefined && parsed.data.role !== "admin";
      const deactivatesSelf = parsed.data.isActive === false;
      if (demotesSelf || deactivatesSelf) {
        return errorResponse(
          "You cannot demote or deactivate your own account",
          "SELF_MUTATION_FORBIDDEN",
          409,
        );
      }
    }

    const result = await updateStaff(session.organizationId, id, parsed.data);
    if (!result.ok) {
      switch (result.reason) {
        case "not_found":
          return errorResponse("User not found", "NOT_FOUND", 404);
        case "last_admin":
          return errorResponse(
            "Cannot remove admin access from the organization's last active admin",
            "LAST_ADMIN",
            409,
          );
        case "no_changes":
          return errorResponse("No changes provided", "VALIDATION_ERROR", 400);
      }
    }

    const ipAddress = request.headers.get("x-forwarded-for") ?? "unknown";
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update_staff",
      entity: "user",
      entityId: id,
      // Field names changed + (when present) the new role enum and active flag.
      // role/isActive are non-PII enums/booleans, safe to record verbatim and
      // they make a demotion distinguishable from a promotion in the trail.
      // The name VALUE is never logged — only that "name" was among the fields.
      details: JSON.stringify({
        fields: Object.keys(parsed.data),
        ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
      }),
      ipAddress,
    });

    return successResponse(result.staff);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update staff member");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
