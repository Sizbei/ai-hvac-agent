/**
 * GET /api/admin/requests/[id]/forms — the request's submissions and the
 * required forms not submitted yet (M3d spec §6). Undecryptable answers read
 * `unreadable`, never a 500.
 */
import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { errorResponse, successResponse } from "@/lib/api-response";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";
import { getRequestForms } from "@/lib/admin/form-queries";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:request-forms:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const r = await getRequestForms(session.organizationId, id);
    if (!r) return errorResponse("Request not found", "NOT_FOUND", 404);
    return successResponse(r);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load request forms");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
