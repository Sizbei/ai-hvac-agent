/**
 * "View as" (spec P7), platform admin only.
 *
 * GET  → { targets }: the session org's active users, minus the caller.
 * POST { userId } → 204 + the signed `hvac_preview` cookie bound to the caller
 *   and the target. 403 not a platform admin / cross-site; 404 the target is
 *   not an active user of the caller's org; 409 already previewing.
 *
 * While the cookie is valid, `src/proxy.ts` refuses every write (Task 14).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/authz";
import {
  PREVIEW_COOKIE,
  PREVIEW_MAX_AGE_S,
  previewCookieOptions,
  signPreviewCookie,
  verifyPreviewCookie,
} from "@/lib/auth/preview-cookie";
import {
  findPreviewTarget,
  listPreviewTargets,
  recordPreviewAudit,
} from "@/lib/admin/preview-targets";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { isSameOriginRequest } from "@/lib/session-csrf";
import { isUuid } from "@/lib/validation/uuid";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const startSchema = z.strictObject({ userId: z.string() });

export async function GET(_request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isPlatformAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }
    const rateCheck = slidingWindow(
      `admin:preview-targets:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const targets = await listPreviewTargets(session.organizationId, session.userId);
    return successResponse({ targets });
  } catch {
    logger.error({ code: "PREVIEW_TARGETS_FAILED" }, "Failed to list preview targets");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
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
      `admin:preview-start:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const authSecret = process.env.AUTH_SECRET ?? "";

    // The proxy already refuses this POST while a bound preview is live; this
    // is the route's own check.
    const existing = request.cookies.get(PREVIEW_COOKIE)?.value;
    if (existing) {
      const claims = await verifyPreviewCookie(existing, authSecret);
      if (claims && claims.adminUserId === session.userId) {
        return errorResponse(
          "You’re already viewing as another user. Exit first.",
          "ALREADY_PREVIEWING",
          409,
        );
      }
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      return errorResponse("Invalid JSON body", "VALIDATION_ERROR", 400);
    }
    const parsed = startSchema.safeParse(body.data);
    if (!parsed.success || !isUuid(parsed.data.userId)) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }
    const { userId } = parsed.data;

    const target =
      userId === session.userId
        ? null
        : await findPreviewTarget(session.organizationId, userId);
    if (!target) {
      return errorResponse("User not found", "NOT_FOUND", 404);
    }

    const value = await signPreviewCookie(
      {
        adminUserId: session.userId,
        targetUserId: target.userId,
        exp: Math.floor(Date.now() / 1000) + PREVIEW_MAX_AGE_S,
      },
      authSecret,
    );
    // Audit before the cookie exists: no row, no preview.
    await recordPreviewAudit({
      action: "preview_start",
      session,
      targetUserId: target.userId,
    });

    const response = new NextResponse(null, { status: 204 });
    response.cookies.set(PREVIEW_COOKIE, value, previewCookieOptions());
    return response;
  } catch {
    logger.error({ code: "PREVIEW_START_FAILED" }, "Failed to start preview");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
