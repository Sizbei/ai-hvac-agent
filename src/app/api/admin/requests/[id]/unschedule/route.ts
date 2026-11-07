import { NextRequest, after } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { unscheduleRequest } from "@/lib/admin/scheduling-queries";
import { visitOneRefusalResponse } from "@/lib/admin/visit-one-guard";
import { syncRequestToCalendar } from "@/lib/integrations/google-calendar/sync";
import { pushJobToHcp } from "@/lib/integrations/housecall-pro/job-sync";
import { logAudit } from "@/lib/admin/audit";
import { FIELDPULSE_BOARD, STALE_LINE, UNSCHEDULE_COPY } from "@/lib/admin/dispatch-copy";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { isUuid } from "@/lib/validation/uuid";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

export const dynamic = "force-dynamic";

/** The card's revision (spec §4.1): both null (no visit #1) or both set. */
const bodySchema = z
  .object({
    visitId: z.uuid().nullable(),
    expectedVersion: z.number().int().min(0).nullable(),
  })
  .refine((b) => (b.visitId === null) === (b.expectedVersion === null), { path: ["expectedVersion"], message: "visitId and expectedVersion go together." });

/**
 * POST /api/admin/requests/[id]/unschedule — drag back to Unscheduled: clear
 * the placement and return the request to the queue. Admin session +
 * adminMutation rate limit + audit. Guards (M2 §5.4): version, FieldPulse,
 * started, work logged.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const { id: rawId } = await params;
    if (!isUuid(rawId)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }
    const id = rawId.toLowerCase();

    const rateCheck = slidingWindow(
      `admin:request-unschedule:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const raw = await readJsonBody(request);
    const parsed = raw.ok ? bodySchema.safeParse(raw.data) : null;
    if (!parsed?.success) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }
    const gate = { visitId: parsed.data.visitId?.toLowerCase() ?? null, expectedVersion: parsed.data.expectedVersion };

    const result = await unscheduleRequest(session.organizationId, id, gate);
    if (!result.ok) {
      switch (result.reason) {
        case "request_not_found":
          return errorResponse("Request not found", "NOT_FOUND", 404);
        case "request_terminal":
          return errorResponse(
            `This request is ${result.currentStatus === "cancelled" ? "cancelled" : "completed"}, so it can’t be moved.`,
            "REQUEST_TERMINAL",
            409,
            { status: result.currentStatus },
          );
        case "managed_externally":
          return errorResponse(FIELDPULSE_BOARD, "MANAGED_EXTERNALLY", 409);
        case "stale":
          return errorResponse(STALE_LINE, "STALE", 409);
        case "work_logged":
          return errorResponse(UNSCHEDULE_COPY.WORK_LOGGED, "WORK_LOGGED", 409);
        case "has_progress":
        case "visit_ended":
          return visitOneRefusalResponse(result.reason, { surface: "unschedule" });
      }
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "request_unscheduled",
      entity: "service_request",
      entityId: id,
      details: JSON.stringify({
        cleared: ["scheduledDate", "arrivalWindow", "assignedTo"],
      }),
      ipAddress: clientIp(request),
    });

    // Mirror the cleared placement outward (idempotent, degrade-safe, no-op when
    // the org isn't connected). No FieldPulse call (M2 §5.1).
    after(() => syncRequestToCalendar(session.organizationId, id));
    after(() => pushJobToHcp(session.organizationId, id));

    return successResponse(result);
  } catch (error: unknown) {
    logger.error({ code: errorCode(error) }, "Failed to unschedule request");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
