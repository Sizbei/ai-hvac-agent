import { successResponse, errorResponse } from "@/lib/api-response";
import { deleteAdminSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

export async function POST() {
  try {
    await deleteAdminSession();
    return successResponse({ message: "Logged out" });
  } catch (error) {
    logger.error({ error }, "Logout failed");
    return errorResponse("Logout failed", "LOGOUT_FAILED", 500);
  }
}
