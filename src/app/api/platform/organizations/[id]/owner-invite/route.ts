/**
 * POST /api/platform/organizations/[id]/owner-invite — "Send owner invite".
 *
 * Platform admins only. Issues an `admin` invite to the org's stored
 * owner_email through createInvite, with the platform admin as the actor —
 * which is what lets acceptInvite promote the acceptor to super_admin
 * (isOwnerPromotion). Also the re-send path: once the previous invite has
 * expired, createInvite revokes it and issues a new one; a still-live pending
 * invite answers 409 INVITE_EXISTS.
 *
 * 201 { emailed, url? } — `url` is the one-time copy link. The platform admin
 * always gets it (controller ruling), present whenever NEXT_PUBLIC_APP_URL is
 * set, because email delivery may be unconfigured or unverified.
 */
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/authz";
import {
  createInvite,
  getOwnerInviteTarget,
  inviteEmailsLast24h,
} from "@/lib/admin/invites";
import { deliverInvite, inviteLink } from "@/lib/admin/invite-email";
import { PLATFORM_PROTECTED_MESSAGE } from "@/lib/admin/staff-errors";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { isSameOriginRequest } from "@/lib/session-csrf";
import { isUuid } from "@/lib/validation/uuid";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  let orgId: string | null = null;
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isPlatformAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }
    if (!isSameOriginRequest(request)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `platform:owner-invite:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!isUuid(id)) {
      return errorResponse("Invalid organization ID format", "INVALID_ID", 400);
    }
    orgId = id;

    const target = await getOwnerInviteTarget(id);
    if (!target) {
      return errorResponse("Organization not found", "NOT_FOUND", 404);
    }
    if (!target.ownerEmail) {
      return errorResponse(
        "This organization has no owner email on file.",
        "NO_OWNER_EMAIL",
        404,
      );
    }

    // Read BEFORE creating, so the cap counts only earlier invites (ruling 4).
    const priorCount = await inviteEmailsLast24h(id);

    const result = await createInvite(
      id,
      { email: target.ownerEmail, role: "admin" },
      session,
    );
    if (!result.ok) {
      switch (result.reason) {
        case "forbidden":
          return errorResponse("Forbidden", "FORBIDDEN", 403);
        case "platform_protected":
          return errorResponse(PLATFORM_PROTECTED_MESSAGE, "PLATFORM_PROTECTED", 403);
        case "email_conflict":
          return errorResponse(
            "The owner already has an account with a password.",
            "EMAIL_CONFLICT",
            409,
          );
        case "invite_exists":
          return errorResponse(
            "There’s already a pending invite for the owner. Revoke it first to send a new one.",
            "INVITE_EXISTS",
            409,
          );
        case "seat_limit":
          return errorResponse(
            "This organization has no free seats.",
            "SEAT_LIMIT_REACHED",
            403,
          );
      }
    }

    const { emailed } = deliverInvite({
      organizationId: id,
      email: result.invite.email,
      orgName: target.name,
      token: result.token,
      role: result.invite.role,
      expiresAt: new Date(result.invite.expiresAt),
      priorCount,
      ownerInvite: true,
    });
    const url = inviteLink(result.token);

    await logAudit({
      organizationId: id,
      userId: session.userId,
      action: "create_invite",
      entity: "staff_invite",
      entityId: result.invite.id,
      // Enums/booleans only — never the owner email, token or link.
      details: JSON.stringify({ role: result.invite.role, ownerInvite: true, emailed }),
      ipAddress: clientIp(request),
    });

    return successResponse({ emailed, ...(url ? { url } : {}) }, 201);
  } catch {
    // Never the error: a DB error's detail can echo the owner's email.
    logger.error(
      { code: "OWNER_INVITE_FAILED", organizationId: orgId },
      "Failed to send owner invite",
    );
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
