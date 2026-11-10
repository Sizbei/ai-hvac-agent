import { successResponse, errorResponse } from "@/lib/api-response";
import { deleteAdminSession } from "@/lib/auth/session";
import { clearPreviewCookie } from "@/lib/auth/preview-cookie";
import { logger } from "@/lib/logger";

export async function POST() {
  try {
    await deleteAdminSession();
    const response = successResponse({ message: "Logged out" });
    // Signing out also ends any "View as" preview.
    clearPreviewCookie(response.cookies);
    return response;
  } catch (error) {
    logger.error({ error }, "Logout failed");
    return errorResponse("Logout failed", "LOGOUT_FAILED", 500);
  }
}
