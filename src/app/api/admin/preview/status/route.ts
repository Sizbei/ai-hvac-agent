/**
 * GET → { previewing, targetUserId }: the "View as" state the server sees for
 * this request (spec P7). The admin shell asks on returning to the tab and
 * reloads when it differs from what is on screen. Ids only.
 */
import { getViewerContext } from "@/lib/auth/viewer";
import { shownPreview } from "@/lib/admin/preview-sync";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";

export async function GET() {
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const rateCheck = slidingWindow(
      `admin:preview-status:${viewer.session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }
    return successResponse(shownPreview(viewer.preview));
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to read the preview status");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
