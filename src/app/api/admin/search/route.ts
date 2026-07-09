import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { searchAllEntities } from "@/lib/admin/search-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:search:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const q = request.nextUrl.searchParams.get("q");
    // Min 2 chars (avoid hot scans on single keystrokes); max 100 chars
    // (bound the ILIKE pattern length an authenticated user can force).
    if (!q || q.trim().length < 2 || q.trim().length > 100) {
      return successResponse({ results: [] });
    }

    const results = await searchAllEntities(session.organizationId, q.trim());
    return successResponse({ results });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to execute admin search");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
