import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getDispatchDecisionForRequest } from "@/lib/admin/dispatch-decision-queries";
import { isUuid } from "@/lib/validation/uuid";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/admin/requests/[id]/decision — the RECORDED dispatch decision for a
 * request (why this tech?). Admin-session gated, org from session, UUID-guarded.
 * Returns the latest decision row (real or shadow); 404 when none exists.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { id } = await params;
    if (!isUuid(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }
    const decision = await getDispatchDecisionForRequest(
      session.organizationId,
      id,
    );
    if (!decision) {
      return errorResponse("No dispatch decision recorded", "NOT_FOUND", 404);
    }
    return successResponse(decision);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to load dispatch decision");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
