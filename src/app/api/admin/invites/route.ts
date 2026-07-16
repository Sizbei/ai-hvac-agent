import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { createInvite, listInvites } from "@/lib/admin/invites";
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
      `admin:invites-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const invites = await listInvites(session.organizationId);
    return successResponse({ invites });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list invites");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

// role is admin|technician only — an invite can NEVER grant super_admin.
const createInviteSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(["admin", "technician"]),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:invites-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = createInviteSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body: a valid email and a role of admin or technician are required",
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await createInvite(
      session.organizationId,
      parsed.data,
      session.role,
      session.userId,
    );

    if (!result.ok) {
      switch (result.reason) {
        case "forbidden":
          return errorResponse(
            "Only a super admin can invite an admin",
            "FORBIDDEN",
            403,
          );
        case "email_conflict":
          return errorResponse(
            "A user with this email already exists in your organization",
            "EMAIL_CONFLICT",
            409,
          );
        case "invite_exists":
          return errorResponse(
            "An active invite for this email already exists",
            "INVITE_EXISTS",
            409,
          );
        case "seat_limit":
          return errorResponse(
            "Your plan's staff limit has been reached. Upgrade your plan to add more team members.",
            "SEAT_LIMIT_REACHED",
            403,
          );
      }
    }

    // Build the one-time accept link from the request origin so it works across
    // environments without an env var. The plaintext token is returned exactly
    // once here (never stored) — the client shows it for the admin to copy.
    const url = new URL(
      `/admin/invite/${result.token}`,
      request.nextUrl.origin,
    ).toString();

    const ipAddress = clientIp(request);
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_invite",
      entity: "staff_invite",
      entityId: result.invite.id,
      // Enum/id only — never the email or the token.
      details: JSON.stringify({ role: result.invite.role }),
      ipAddress,
    });

    return successResponse({ invite: result.invite, url }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create invite");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
