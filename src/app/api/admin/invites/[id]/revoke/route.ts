import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { revokeInvite, getInviteRole } from "@/lib/admin/invites";
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

export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid invite ID format", "INVALID_ID", 400);
    }

    const rateCheck = slidingWindow(
      `admin:invite-revoke:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    // Admin-tier invites may only be revoked by a super_admin — a regular admin
    // revoking a colleague's invite is an intra-org sabotage vector.
    // Technician-tier invites remain revocable by any admin.
    const inviteRole = await getInviteRole(session.organizationId, id);
    if (inviteRole === "admin" && session.role !== "super_admin") {
      return errorResponse(
        "Only a super admin can revoke admin invites",
        "FORBIDDEN",
        403,
      );
    }

    const result = await revokeInvite(session.organizationId, id);
    if (!result.ok) {
      return errorResponse("Invite not found", "NOT_FOUND", 404);
    }

    const ipAddress = clientIp(_request);
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "revoke_invite",
      entity: "staff_invite",
      entityId: id,
      ipAddress,
    });

    return successResponse({ id });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to revoke invite");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
