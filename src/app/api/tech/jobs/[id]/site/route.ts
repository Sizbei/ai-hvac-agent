/** GET /api/tech/jobs/[id]/site — what the technician should know about this address (M3d spec §7.6). */
import type { NextRequest } from "next/server";
import { getTechSession } from "@/lib/auth/tech-session";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse, successResponse } from "@/lib/api-response";
import { errorCode, logger } from "@/lib/logger";
import { getSiteView } from "@/lib/tech/site-queries";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const rate = slidingWindow(`tech:site:read:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
    const r = await getSiteView(session.organizationId, session.userId, id);
    if (r.kind === "not_found") return errorResponse("This job isn't yours.", "NOT_FOUND", 404);
    return successResponse(r.view);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load the site view");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}
