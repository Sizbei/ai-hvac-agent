/**
 * Per-user admin guide (onboarding spec D1).
 * PATCH { dismissWelcome?, lesson?, tourCompleted? } → 204, always: it writes
 * only the session user's own row and never says whether a row matched. Not
 * audited (the technician guide is the precedent). The read is part of
 * GET /api/admin/onboarding (`guide`).
 */
import { NextRequest, NextResponse } from "next/server";
import { getViewerContext } from "@/lib/auth/viewer";
import { PREVIEW_COOKIE } from "@/lib/auth/preview-cookie";
import { patchAdminGuide } from "@/lib/admin/admin-guide-queries";
import { guidePatchSchema } from "@/lib/admin/admin-guide-state";
import { isSameOriginRequest } from "@/lib/session-csrf";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { errorResponse, readJsonBody } from "@/lib/api-response";
import { logger, errorCode } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest) {
  try {
    const viewer = await getViewerContext();
    if (!viewer) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    if (!isSameOriginRequest(request)) return errorResponse("Forbidden", "FORBIDDEN", 403);
    // The proxy refuses this too; any preview cookie counts, as in the onboarding GET.
    if (viewer.preview !== null || request.cookies.has(PREVIEW_COOKIE)) {
      return errorResponse("Read-only while viewing as another user", "PREVIEW_READ_ONLY", 403);
    }
    const { session } = viewer;
    const rate = slidingWindow(
      `admin:guide-patch:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const body = await readJsonBody(request);
    const parsed = body.ok ? guidePatchSchema.safeParse(body.data) : null;
    if (!parsed?.success) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    await patchAdminGuide(session.organizationId, session.userId, parsed.data);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to update the admin guide");
    return errorResponse("Couldn’t save your progress. Please try again.", "INTERNAL_ERROR", 500);
  }
}
