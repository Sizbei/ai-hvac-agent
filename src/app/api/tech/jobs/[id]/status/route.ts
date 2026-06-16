/**
 * Stage 7 — technician advances a job's status from the field.
 *
 * A tech can only move a job ASSIGNED TO THEM. Delegates to updateRequestStatus
 * (FSM-guarded + records a request_status_event with actorType=human, actorId =
 * the tech) so field status changes feed the same KPI/automation pipeline as
 * dispatcher changes.
 */
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { updateRequestStatus } from "@/lib/admin/queries";
import { MANUAL_TARGET_STATUSES } from "@/lib/admin/request-status";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

const bodySchema = z.object({ status: z.enum(MANUAL_TARGET_STATUSES) });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const rate = slidingWindow(
      `tech:status:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid status", "INVALID_INPUT", 400);
    }

    // A tech may only advance a job assigned to THEM (org-scoped + assignee-scoped).
    const [owned] = await db
      .select({ id: serviceRequests.id })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          session.organizationId,
          and(
            eq(serviceRequests.id, id),
            eq(serviceRequests.assignedTo, session.userId),
          )!,
        ),
      )
      .limit(1);
    if (!owned) {
      return errorResponse("Job not found or not assigned to you", "NOT_FOUND", 404);
    }

    const result = await updateRequestStatus(
      session.organizationId,
      id,
      parsed.data.status,
      undefined,
      { actorType: "human", actorId: session.userId },
    );
    if (!result.ok) {
      return errorResponse(
        result.reason === "invalid_transition"
          ? "That status change isn't allowed from the current state"
          : "Job not found",
        result.reason === "invalid_transition" ? "INVALID_TRANSITION" : "NOT_FOUND",
        result.reason === "invalid_transition" ? 409 : 404,
      );
    }

    logger.info(
      { serviceRequestId: id, technicianId: session.userId, status: result.status },
      "Technician advanced job status",
    );
    return successResponse({ status: result.status });
  } catch (error) {
    logger.error({ error }, "Failed to advance job status");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
