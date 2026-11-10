/**
 * POST /api/admin/preview/exit — leave "View as" (spec P7).
 *
 * Always clears the cookie (204), so nobody can get stuck read-only. The
 * preview_exit audit row is written only for a valid cookie bound to the
 * signed-in admin, at most one per started preview, so no rate limit is
 * needed. The proxy lets this POST through while previewing.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import {
  PREVIEW_COOKIE,
  clearPreviewCookie,
  verifyPreviewCookie,
} from "@/lib/auth/preview-cookie";
import { recordPreviewAudit } from "@/lib/admin/preview-targets";
import { errorResponse } from "@/lib/api-response";
import { isSameOriginRequest } from "@/lib/session-csrf";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return errorResponse("Forbidden", "FORBIDDEN", 403);
  }

  try {
    const value = request.cookies.get(PREVIEW_COOKIE)?.value;
    const claims = value
      ? await verifyPreviewCookie(value, process.env.AUTH_SECRET ?? "")
      : null;
    if (claims) {
      const session = await getAdminSession();
      if (session && session.userId === claims.adminUserId) {
        await recordPreviewAudit({
          action: "preview_exit",
          session,
          targetUserId: claims.targetUserId,
        });
      }
    }
  } catch {
    // The exit itself must still happen.
    logger.error({ code: "PREVIEW_EXIT_AUDIT_FAILED" }, "Failed to audit preview exit");
  }

  const response = new NextResponse(null, { status: 204 });
  clearPreviewCookie(response.cookies);
  return response;
}
