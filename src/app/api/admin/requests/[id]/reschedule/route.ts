import { NextRequest, after } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { placeAndAssignRequest } from "@/lib/admin/scheduling-queries";
import { syncRequestToCalendar } from "@/lib/integrations/google-calendar/sync";
import {
  arrivalWindowUtcForBusinessDate,
  isRealIsoDate,
} from "@/lib/admin/calendar-time";
import {
  ARRIVAL_WINDOWS,
  type ArrivalWindow,
} from "@/lib/admin/arrival-window";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { z } from "zod";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `date` is the BUSINESS-timezone (America/New_York) calendar date the job was
// dropped on — the same day the calendar grid renders. `arrivalWindow` is the
// window row it landed in. The server resolves these to UTC instants in the
// business timezone (DST-correct) before persisting, so a drop on the Eastern
// "morning" row stores 8 AM–12 PM Eastern, not 8–12 UTC.
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// `technicianId` is OPTIONAL: present on a drag-to-ASSIGN (drop into another
// tech's lane → reassign + re-time in one atomic write), absent on a pure
// reschedule (keep the current assignee, move only the WHEN). `override` lets the
// dispatcher commit a placement the server flagged as conflicting/out-of-hours
// AFTER confirming the inline warning — the server is still the gate (it blocks
// with a 409 unless override is explicitly true).
const rescheduleSchema = z.object({
  date: z.string().regex(ISO_DATE_REGEX, "date must be YYYY-MM-DD"),
  arrivalWindow: z.enum([...ARRIVAL_WINDOWS] as [string, ...string[]]),
  technicianId: z.string().uuid().optional(),
  override: z.boolean().optional(),
});

/** Best-effort client IP for the audit trail. x-forwarded-for is client-
 * controllable, so we take only the leftmost address and cap the length (45 =
 * longest IPv6) — stored via a parameterized insert, never trusted. */
function clientIp(request: NextRequest): string {
  const raw = request.headers.get("x-forwarded-for");
  return raw?.split(",")[0]?.trim().slice(0, 45) || "unknown";
}

/**
 * POST /api/admin/requests/[id]/reschedule — drag-to-reschedule a job to a new
 * arrival window on a business-tz day. Admin session + adminMutation rate limit
 * + audit, mirroring the assign route. Atomically sets scheduledDate +
 * arrivalWindowStart/End; rejects terminal requests; surfaces (soft) conflicts.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const rateCheck = slidingWindow(
      `admin:request-reschedule:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = rescheduleSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        parsed.error.issues[0]?.message ??
          "Invalid request body: provide date (YYYY-MM-DD) and arrivalWindow",
        "VALIDATION_ERROR",
        400,
      );
    }
    if (!isRealIsoDate(parsed.data.date)) {
      return errorResponse("Invalid calendar date", "VALIDATION_ERROR", 400);
    }

    const arrivalWindow = parsed.data.arrivalWindow as ArrivalWindow;
    // Resolve the dropped day + window to UTC instants, reading the window hours
    // as Eastern wall-clock (the grid's timezone), DST-correct.
    const window = arrivalWindowUtcForBusinessDate(parsed.data.date, arrivalWindow);

    const result = await placeAndAssignRequest(
      session.organizationId,
      id,
      window,
      {
        isoDay: parsed.data.date,
        window: arrivalWindow,
        technicianId: parsed.data.technicianId,
        override: parsed.data.override,
      },
    );

    if (!result.ok) {
      switch (result.reason) {
        case "request_not_found":
          return errorResponse("Request not found", "NOT_FOUND", 404);
        case "technician_not_found":
          return errorResponse(
            "Technician not found, not active, or not a technician",
            "TECHNICIAN_NOT_FOUND",
            404,
          );
        case "request_terminal":
          return errorResponse(
            `Request cannot be rescheduled while it is '${result.currentStatus}'`,
            "REQUEST_TERMINAL",
            409,
          );
        case "conflict":
          // HARD block (S4): the move overlaps an existing job and/or falls
          // outside the tech's hours. 409 + the conflict detail so the client can
          // show the inline warning and offer "schedule anyway" (override). No
          // audit row — nothing was written.
          return errorResponse(
            result.detail.outsideAvailability && result.detail.conflicts.length
              ? "This time overlaps another job and is outside the technician's hours."
              : result.detail.outsideAvailability
                ? "This time is outside the technician's working hours."
                : "This time overlaps another job for the technician.",
            "SCHEDULE_CONFLICT",
            409,
            result.detail,
          );
      }
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      // Distinguish a reassignment (tech changed) from a pure reschedule so the
      // audit trail records WHO moved as well as WHEN.
      action: parsed.data.technicianId
        ? "request_reassigned_scheduled"
        : "request_rescheduled",
      entity: "service_request",
      entityId: id,
      // Date + window + non-PII ids/flags only: no customer data. `override`
      // records when a dispatcher deliberately scheduled despite a conflict.
      details: JSON.stringify({
        date: parsed.data.date,
        arrivalWindow: parsed.data.arrivalWindow,
        arrivalWindowStart: result.arrivalWindowStart,
        arrivalWindowEnd: result.arrivalWindowEnd,
        technicianId: parsed.data.technicianId ?? null,
        override: parsed.data.override === true,
        overriddenConflictCount:
          result.overriddenConflicts?.conflicts.length ?? 0,
        overriddenOutsideAvailability:
          result.overriddenConflicts?.outsideAvailability ?? false,
      }),
      ipAddress: clientIp(request),
    });

    // Mirror the new arrival window into Google Calendar (idempotent upsert) in
    // the background — after() so the response isn't blocked and a Google
    // outage can't fail the reschedule. No-ops when the org isn't connected.
    after(() => syncRequestToCalendar(session.organizationId, id));

    return successResponse(result);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to reschedule request");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
