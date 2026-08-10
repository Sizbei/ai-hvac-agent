/**
 * DELETE /api/platform/organizations/[id] — PLATFORM tenant purge.
 *
 * Destructive + irreversible: deletes the org, cascading every org-scoped table
 * (migration 0017 makes the 24 org FKs ON DELETE CASCADE). Evidence is written
 * to platform_audit_log (which is NOT org-FK'd and so survives the cascade).
 *
 * PLATFORM-GATED ONLY: getAdminSession THEN isPlatformAdmin (an env allowlist).
 * A normal org super_admin is NOT a platform admin and gets a 403 — purging a
 * tenant is a cross-org platform operation, never an in-org one.
 */
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/authz";
import { purgeOrganization } from "@/lib/admin/erasure-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isPlatformAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `platform:org-purge:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid organization ID format", "INVALID_ID", 400);
    }

    // Refuse to purge the platform's own operating org. users.organizationId
    // cascades on org delete, so purging this org deletes every platform admin
    // user row; isPlatformAdmin requires session.organizationId === platformOrgId
    // (authz.ts), so no session could ever pass that check again — an
    // irrecoverable, product-wide lockout. (isPlatformAdmin already fails closed
    // when PLATFORM_ORG_ID is unset, so reaching this line guarantees it's set.)
    if (id === process.env.PLATFORM_ORG_ID?.trim()) {
      return errorResponse(
        "The platform's own organization cannot be purged",
        "PLATFORM_ORG_PURGE_FORBIDDEN",
        409,
      );
    }

    const purged = await purgeOrganization(id, {
      userId: session.userId,
      email: session.email,
    });
    if (!purged) {
      return errorResponse("Organization not found", "NOT_FOUND", 404);
    }

    return successResponse({ ok: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to purge organization");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
