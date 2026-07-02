/**
 * Technician field workflow — a job's status-change timeline (read-only).
 *
 * GET the ordered status history for a job assigned to the calling tech. Reuses
 * the append-only request_status_events log. Assignee + tenant guarded in
 * field-queries (a tech may only see their OWN job's timeline). PII-free.
 *
 * Auth mirrors the other tech routes: getTechSession (technician role) + the
 * assignee+tenant guard in the query layer.
 */
import { NextRequest } from "next/server";
import { getTechSession } from "@/lib/auth/tech-session";
import { getJobTimelineForTech } from "@/lib/tech/field-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

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
    const result = await getJobTimelineForTech(
      session.organizationId,
      session.userId,
      id,
    );
    if (!result.ok) {
      return errorResponse(
        "Job not found or not assigned to you",
        "NOT_FOUND",
        404,
      );
    }
    return successResponse({ timeline: result.timeline });
  } catch (error) {
    logger.error({ error }, "Failed to load job timeline");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
