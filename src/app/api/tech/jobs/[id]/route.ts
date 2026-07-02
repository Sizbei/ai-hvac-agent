import { NextRequest } from "next/server";
import { getTechSession } from "@/lib/auth/tech-session";
import { getTechJobSummary } from "@/lib/tech/field-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/tech/jobs/[id] — the calling technician's full summary for ONE job
 * they're assigned to (customer/address/issue/schedule + allowed next statuses).
 * Technician session only; assignee + tenant guarded in getTechJobSummary, so a
 * job that isn't theirs returns 404 (not 403 — don't confirm it exists).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const summary = await getTechJobSummary(
      session.organizationId,
      session.userId,
      id,
    );
    if (!summary) {
      return errorResponse("Job not found", "NOT_FOUND", 404);
    }

    return successResponse(summary);
  } catch (error) {
    logger.error({ error }, "Failed to load tech job summary");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
