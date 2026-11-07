/**
 * GET /api/tech/jobs/[id]/forms?visit=<aid> — the visit's forms for the job
 * page card (M3d spec §6). Any technician who can read the job; the visit must
 * belong to the request and count (spec §5.1), else 404.
 */
import type { NextRequest } from "next/server";
import { getTechSession } from "@/lib/auth/tech-session";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse, successResponse } from "@/lib/api-response";
import { errorCode, logger } from "@/lib/logger";
import { getJobForms } from "@/lib/tech/form-reads";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const { id } = await params;
    const visit = request.nextUrl.searchParams.get("visit");
    if (!isUuid(id) || !isUuid(visit)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const rate = slidingWindow(`tech:form:read:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
    const r = await getJobForms(session.organizationId, session.userId, id, visit);
    if (r.kind === "not_found") return errorResponse("This job isn't yours.", "NOT_FOUND", 404);
    return successResponse(r.view);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load job forms");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}
