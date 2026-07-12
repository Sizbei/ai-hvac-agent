import { successResponse, errorResponse } from "@/lib/api-response";
import { deleteTechSession } from "@/lib/auth/tech-session";
import { logger } from "@/lib/logger";

/**
 * POST /api/auth/tech/logout — end the TECHNICIAN session (hvac_tech_session).
 * Parallel to /api/auth/logout, which clears only the admin cookie: without
 * this route a tech on a shared device stayed signed in for the full 24h JWT.
 */
export async function POST() {
  try {
    await deleteTechSession();
    return successResponse({ message: "Logged out" });
  } catch (error) {
    logger.error({ error }, "Technician logout failed");
    return errorResponse("Logout failed", "LOGOUT_FAILED", 500);
  }
}
