import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { PLATFORM_PROTECTED_MESSAGE } from "@/lib/admin/staff-errors";
import { createInvite, listInvites, inviteEmailsLast24h } from "@/lib/admin/invites";
import { deliverInvite, inviteLink } from "@/lib/admin/invite-email";
import { isPlatformAdmin } from "@/lib/auth/authz";
import { loadOrgRow } from "@/lib/tenancy/org-row";
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
  let organizationId: string | null = null;
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    organizationId = session.organizationId;

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

    // Read BEFORE creating, so the cap counts only earlier invites (ruling 4).
    const priorCount = await inviteEmailsLast24h(session.organizationId);

    const result = await createInvite(
      session.organizationId,
      parsed.data,
      session,
    );

    if (!result.ok) {
      switch (result.reason) {
        case "forbidden":
          return errorResponse(
            "Only a super admin can invite an admin",
            "FORBIDDEN",
            403,
          );
        case "platform_protected":
          return errorResponse(
            PLATFORM_PROTECTED_MESSAGE,
            "PLATFORM_PROTECTED",
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

    const org = await loadOrgRow(session.organizationId);
    const { emailed } = deliverInvite({
      organizationId: session.organizationId,
      email: result.invite.email,
      orgName: org?.name ?? "your team",
      token: result.token,
      role: result.invite.role,
      expiresAt: new Date(result.invite.expiresAt),
      priorCount,
    });

    // Not emailed: the one-time link (from NEXT_PUBLIC_APP_URL only, never the
    // request origin) is shown once — to a super_admin or platform admin only.
    const mayShowLink = session.role === "super_admin" || isPlatformAdmin(session);
    const url = !emailed && mayShowLink ? inviteLink(result.token) : null;

    const ipAddress = clientIp(request);
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_invite",
      entity: "staff_invite",
      entityId: result.invite.id,
      // Enum/boolean only — never the email, token or link.
      details: JSON.stringify({ role: result.invite.role, emailed }),
      ipAddress,
    });

    return successResponse(
      { invite: result.invite, emailed, ...(url ? { url } : {}) },
      201,
    );
  } catch {
    // Never the error: a pg unique-violation detail echoes the invitee's email.
    logger.error({ code: "INVITE_CREATE_FAILED", organizationId }, "Failed to create invite");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
