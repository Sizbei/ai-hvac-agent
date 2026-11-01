/**
 * A technician's status tap. Each technician moves their OWN assignment row;
 * the active visit's lead also moves the request ("whichever is behind"),
 * holds the visit, and closes the job out. Writes live in status-writes.ts
 * (one batch each); the rules live in status-actions.ts (pure).
 *
 * Pre-checks: readable job (404) → native (409) → the caller's row (404) →
 * every row → active visit → resolve.
 */
import { NextRequest, after } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import {
  findAllAssignments, findReadableJob, findTechAssignments, hasProgress, isOpen,
  pickActiveAssignment, pickActiveVisit, type TechAssignmentRow,
} from "@/lib/tech/ownership";
import { allowedActions, resolveTechAction, TECH_ACTIONS, type Blocker, type TechAction } from "@/lib/tech/status-actions";
import { applyTechAction, closeOutBlockers, closeOutRequest, holdVisit, isDeadlock } from "@/lib/tech/status-writes";
import { createReviewRequest } from "@/lib/reviews/review-queries";
import { HOLD_REASONS, MANUAL_TARGET_STATUSES, type RequestStatus } from "@/lib/admin/request-status";
import { requestStatusEnum } from "@/lib/db/schema";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { logger } from "@/lib/logger";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z.object({
  appointmentId: z.uuid().optional(),
  action: z.enum(TECH_ACTIONS).optional(),
  // Legacy body (the current UI until Task 6).
  status: z.enum(MANUAL_TARGET_STATUSES).optional(),
  expectedStatus: z.enum(requestStatusEnum.enumValues).optional(),
  holdReason: z.enum(HOLD_REASONS).optional(),
  followUpDate: z.string().datetime().optional(),
});

const STALE = () => errorResponse("This job changed. Refresh and try again.", "STALE", 409);
const NOT_STARTED = () => errorResponse("Tap Working before marking done.", "REQUEST_NOT_STARTED", 409);

/** Legacy `{ status }`: on_hold is a pause; done from the active lead with nobody else open is a close-out. */
function legacyAction(status: RequestStatus, row: TechAssignmentRow, all: readonly TechAssignmentRow[], activeVisitId: string | null): TechAction {
  if (status === "on_hold") return "pause";
  if (status === "completed") {
    const activeLead = row.isLead && row.appointmentId === activeVisitId;
    const othersOpen = all.some((r) => r.assignmentId !== row.assignmentId && isOpen(r.status));
    return activeLead && !othersOpen ? "close_out" : "completed";
  }
  return status as TechAction;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getTechSession();
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
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }
    const body = await readJsonBody(request);
    const parsed = body.ok ? bodySchema.safeParse(body.data) : null;
    if (!parsed?.success || (!parsed.data.action && !parsed.data.status)) {
      return errorResponse("Invalid status", "INVALID_INPUT", 400);
    }
    const input = parsed.data;
    if (!input.action && (input.status === "cancelled" || input.status === "scheduled")) {
      return errorResponse("Technicians can't set that status.", "NOT_TECH_TARGET", 400);
    }
    if (input.action === "on_hold" && !input.holdReason) {
      return errorResponse("Pick a reason for the hold.", "INVALID_INPUT", 400);
    }

    const org = session.organizationId;
    const me = session.userId;
    const job = await findReadableJob(org, me, id);
    if (!job) {
      return errorResponse("Job not found or not assigned to you", "NOT_FOUND", 404);
    }
    if (!job.native) {
      return errorResponse("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
    }
    const [mine, all] = await Promise.all([findTechAssignments(org, me, id), findAllAssignments(org, id)]);
    const active = pickActiveVisit(all);
    const activeVisitId = active?.appointmentId ?? null;
    const row = input.appointmentId
      ? mine.find((r) => r.appointmentId === input.appointmentId)
      : pickActiveAssignment(mine, activeVisitId);
    if (!row) {
      return errorResponse("Job not found or not assigned to you", "NOT_FOUND", 404);
    }

    const action = input.action ?? legacyAction(input.status!, row, all, activeVisitId);
    const base = { requestStatus: job.status, activeVisitId, activeLeadId: active?.leadTechnicianId ?? null, native: true };
    const resolved = resolveTechAction({ ...base, action, row });

    // 200 body: the caller's row and request after the write.
    const respond = async (after_: TechAssignmentRow, requestStatus: RequestStatus, requestBehind: boolean, changed?: boolean) => {
      const blockers: Blocker[] = after_.isLead && requestStatus !== "completed"
        ? await closeOutBlockers(org, id, { technicianId: me, appointmentId: after_.appointmentId })
        : [];
      return successResponse({
        assignmentStatus: after_.status, requestStatus, requestBehind,
        allowedActions: allowedActions({ ...base, requestStatus, row: after_ }),
        blockers,
        ...(changed === undefined ? {} : { changed }),
      });
    };

    switch (resolved.kind) {
      case "refuse":
        switch (resolved.reason) {
          case "not_lead":
            return errorResponse("Only the lead technician can do that.", "NOT_LEAD", 403);
          case "managed_externally":
            return errorResponse("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
          case "not_tech_target":
            return errorResponse("Technicians can't set that status.", "NOT_TECH_TARGET", 400);
          case "request_not_started":
          case "not_started_row":
            return NOT_STARTED();
          case "invalid_transition":
            return errorResponse("That status change isn't allowed from the current state", "INVALID_TRANSITION", 409);
        }
        break;
      case "noop":
        return respond(row, job.status, row.isLead && row.appointmentId !== activeVisitId);
      case "write":
      case "request_only": {
        const casRow = input.expectedStatus ? { ...row, status: input.expectedStatus } : row;
        const result = await applyTechAction({ organizationId: org, techUserId: me, requestId: id, row: casRow, resolved, requestStatus: job.status, activeVisitId });
        if (!result.ok) return STALE();
        const stamp = resolved.kind === "write" ? resolved.stamp : null;
        const rowAfter = { ...row, status: result.assignmentStatus, ...(stamp ? { [stamp]: row[stamp] ?? new Date() } : {}) };
        logger.info({ serviceRequestId: id, technicianId: me, action, assignmentStatus: result.assignmentStatus }, "Technician status tap");
        return respond(rowAfter, result.requestStatus, result.requestBehind);
      }
      case "hold": {
        const result = await holdVisit({
          organizationId: org, actorUserId: me, requestId: id, appointmentId: row.appointmentId,
          holdReason: input.holdReason ?? null,
          followUpDate: input.followUpDate ? new Date(input.followUpDate) : null,
          requestStatus: job.status,
        });
        if (!result.ok) {
          return result.reason === "stale"
            ? STALE()
            : errorResponse("That status change isn't allowed from the current state", "INVALID_TRANSITION", 409);
        }
        const ended: RequestStatus = isOpen(row.status) ? (hasProgress(row) ? "completed" : "cancelled") : row.status;
        logger.info({ serviceRequestId: id, technicianId: me, action }, "Technician put the visit on hold");
        return respond({ ...row, status: ended }, "on_hold", false);
      }
      case "close_out": {
        const result = await closeOutRequest({ organizationId: org, techUserId: me, requestId: id, row });
        if (!result.ok) {
          const details = { assignmentStatus: result.assignmentStatus, blockers: result.blockers };
          if (result.blockers.length > 0 && result.blockers.every((b) => b.kind === "request_not_started")) {
            return errorResponse("Tap Working before marking done.", "REQUEST_NOT_STARTED", 409, details);
          }
          return errorResponse("This job can't be closed out yet.", "CLOSE_OUT_BLOCKED", 409, details);
        }
        logger.info({ serviceRequestId: id, technicianId: me, changed: result.changed }, "Technician closed out job");
        // Post-job review ask, only for the close-out that completed the
        // request. Best-effort + non-blocking; idempotent per job.
        if (result.changed) {
          const customerId = job.customerId;
          after(() =>
            createReviewRequest(org, id, customerId).catch((reviewError: unknown) => {
              logger.error({ error: reviewError, serviceRequestId: id }, "createReviewRequest failed (best-effort)");
            }),
          );
        }
        return successResponse({
          assignmentStatus: result.assignmentStatus, requestStatus: "completed", requestBehind: false,
          allowedActions: [], blockers: [], changed: result.changed,
        });
      }
    }
    return errorResponse("That status change isn't allowed from the current state", "INVALID_TRANSITION", 409);
  } catch (error) {
    if (isDeadlock(error)) return STALE();
    logger.error({ error }, "Failed to advance job status");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
