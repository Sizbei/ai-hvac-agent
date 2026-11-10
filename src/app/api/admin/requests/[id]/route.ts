import { after } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getViewerContext } from "@/lib/auth/viewer";
import {
  getRequestById,
  updateRequestStatus,
  scheduleRequest,
  addRequestNote,
} from "@/lib/admin/queries";
import {
  syncRequestToCalendar,
  deleteRequestFromCalendar,
} from "@/lib/integrations/google-calendar/sync";
import {
  pushJobToHcp,
  cancelHcpJob,
} from "@/lib/integrations/housecall-pro/job-sync";
import {
  pushJobToFieldpulse,
  cancelFieldpulseJob,
} from "@/lib/integrations/fieldpulse/job-sync";
import { syncJobNoteToHcp } from "@/lib/integrations/housecall-pro/note-sync";
import { syncNoteToFieldpulse } from "@/lib/integrations/fieldpulse/note-sync";
import { readVisitEnded } from "@/lib/admin/current-visit";
import {
  MANUAL_TARGET_STATUSES,
  RESUME_TARGET_STATUSES,
  transitionRefusedMessage,
  HOLD_REASONS,
  type HoldReason,
  type RequestStatus,
} from "@/lib/admin/request-status";
import { isFieldpulseMapped, visitOneRefusalResponse } from "@/lib/admin/visit-one-guard";
import { findActiveVisit } from "@/lib/tech/ownership";
import {
  completeRequestFromAdmin,
  holdVisit,
  isDeadlock,
  readRequestState,
} from "@/lib/tech/status-writes";
import {
  ARRIVAL_WINDOWS,
  type ArrivalWindow,
} from "@/lib/admin/arrival-window";
import { arrivalWindowUtcForBusinessDate } from "@/lib/admin/calendar-time";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { z } from "zod";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A PATCH can set a status transition, a scheduled date (+ optional arrival
// window), or both. At least one must be present. `scheduledDate` accepts an ISO
// datetime or null (to clear). `arrivalWindow` is one of the window names (or
// null to clear); when set, the server resolves it to start/end timestamps on
// the scheduled date.
const patchSchema = z
  .object({
    status: z
      .enum([...MANUAL_TARGET_STATUSES] as [string, ...string[]])
      .optional(),
    scheduledDate: z.string().datetime().nullable().optional(),
    arrivalWindow: z
      .enum([...ARRIVAL_WINDOWS] as [string, ...string[]])
      .nullable()
      .optional(),
    // Hold metadata — only meaningful when status === "on_hold".
    holdReason: z
      .enum([...HOLD_REASONS] as [string, ...string[]])
      .nullable()
      .optional(),
    followUpDate: z.string().datetime().nullable().optional(),
  })
  .refine(
    (v) =>
      v.status !== undefined ||
      v.scheduledDate !== undefined ||
      v.arrivalWindow !== undefined,
    { message: "Provide a status, scheduledDate, and/or arrivalWindow" },
  );

const MAX_NOTE_LENGTH = 5000;
const noteSchema = z.object({
  content: z.string().trim().min(1).max(MAX_NOTE_LENGTH),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { session } = viewer;

    const rateCheck = slidingWindow(
      `admin:request-get:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;

    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const detail = await getRequestById(session.organizationId, id, viewer);
    if (!detail) {
      return errorResponse("Request not found", "NOT_FOUND", 404);
    }

    return successResponse(detail);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch request detail");
    return errorResponse("Couldn’t load this request. Please try again.", "INTERNAL_ERROR", 500);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { session } = viewer;

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const rateCheck = slidingWindow(
      `admin:request-patch:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        parsed.error.issues[0]?.message ?? "Invalid request body",
        "VALIDATION_ERROR",
        400,
      );
    }

    // Apply the status transition FIRST — it's the failure-prone, race-guarded
    // step (a concurrent dispatcher can reject it with 409). Doing it first
    // means a partial failure leaves "status unchanged, schedule unchanged"
    // rather than "schedule committed but status rejected" — the latter would
    // silently persist a write while returning an error. The two writes are not
    // transactional (neon-http), so ordering is our only lever here.
    //
    // Track what changed so a SINGLE Google Calendar sync fires after both
    // writes: a cancellation DELETES the event; a (re)schedule UPSERTS it.
    // Delete wins if both somehow apply in one PATCH.
    let calendarCancelled = false;
    let calendarScheduleChanged = false;
    // A schedule CLEARED (date+window removed) must DELETE the calendar event —
    // syncRequestToCalendar no-ops with no window, so it would leave a stale one.
    let scheduleCleared = false;

    if (parsed.data.status !== undefined) {
      // Hold metadata only applies to an on_hold transition; updateRequestStatus
      // clears it on any other target.
      const holdDetails =
        parsed.data.status === "on_hold"
          ? {
              reason: (parsed.data.holdReason ?? null) as HoldReason | null,
              followUpDate: parsed.data.followUpDate
                ? new Date(parsed.data.followUpDate)
                : null,
            }
          : undefined;
      const target = parsed.data.status as (typeof MANUAL_TARGET_STATUSES)[number];
      const invalid = (from: string) =>
        errorResponse(
          transitionRefusedMessage(from),
          "INVALID_TRANSITION",
          409,
          { currentStatus: from },
        );
      const isResume = (RESUME_TARGET_STATUSES as readonly string[]).includes(target);
      // A NATIVE request's hold and completion follow the technician rules
      // (the hold ends the active visit; completion refuses while a technician
      // is still working). Synced requests keep updateRequestStatus.
      const state =
        target === "on_hold" || target === "completed" || isResume
          ? await readRequestState(session.organizationId, id)
          : null;
      // M3a: a hold ENDS the visit and the office plans the next one. A bare
      // status resume would leave the request pointing at the ended visit
      // (the technician's phone no longer lists it), so it is refused here and
      // the sheet offers "Schedule next visit" (POST …/appointments) instead.
      if (
        isResume &&
        state?.native &&
        state.status === "on_hold" &&
        (await readVisitEnded(session.organizationId, id))
      ) {
        return errorResponse(
          "This visit ended when the request was put on hold. Schedule the next visit instead.",
          "VISIT_ENDED",
          409,
        );
      }
      let result: { readonly ok: true; readonly status: RequestStatus };
      if (state?.native && target === "on_hold") {
        const active = await findActiveVisit(session.organizationId, id);
        const held = await holdVisit({
          organizationId: session.organizationId,
          actorUserId: session.userId,
          requestId: id,
          appointmentId: active?.appointmentId ?? null,
          holdReason: holdDetails?.reason ?? null,
          followUpDate: holdDetails?.followUpDate ?? null,
          requestStatus: state.status,
        });
        if (!held.ok) {
          return held.reason === "stale"
            ? errorResponse("This job changed. Refresh and try again.", "STALE", 409)
            : invalid(state.status);
        }
        result = { ok: true, status: "on_hold" };
      } else if (state?.native && target === "completed") {
        const done = await completeRequestFromAdmin({
          organizationId: session.organizationId,
          actorUserId: session.userId,
          requestId: id,
        });
        if (!done.ok) {
          // Blockers carry technician names: response body only, never audit.
          return done.reason === "blocked"
            ? errorResponse("A technician is still working this job.", "CLOSE_OUT_BLOCKED", 409, { blockers: done.blockers })
            : invalid(done.currentStatus);
        }
        result = { ok: true, status: "completed" };
      } else {
        const updated = await updateRequestStatus(
          session.organizationId,
          id,
          target,
          holdDetails,
        );
        if (!updated.ok) {
          if (updated.reason === "request_not_found") {
            return errorResponse("Request not found", "NOT_FOUND", 404);
          }
          return invalid(updated.currentStatus);
        }
        result = updated;
      }
      await logAudit({
        organizationId: session.organizationId,
        userId: session.userId,
        action: "request_status_changed",
        entity: "service_request",
        entityId: id,
        details: JSON.stringify({ status: result.status }),
      });
      if (result.status === "cancelled") {
        calendarCancelled = true;
      }
    }

    if (
      parsed.data.scheduledDate !== undefined ||
      parsed.data.arrivalWindow !== undefined
    ) {
      // A window needs a date to anchor to. Setting a window WITHOUT providing a
      // date (scheduledDate undefined) would fall through to when=null and
      // silently WIPE the existing schedule — reject it instead. (Sending
      // scheduledDate:null explicitly still clears both, as intended.)
      if (
        parsed.data.arrivalWindow !== undefined &&
        parsed.data.arrivalWindow !== null &&
        parsed.data.scheduledDate === undefined
      ) {
        return errorResponse(
          "arrivalWindow requires scheduledDate",
          "VALIDATION_ERROR",
          400,
        );
      }
      const when = parsed.data.scheduledDate
        ? new Date(parsed.data.scheduledDate)
        : null;
      // Resolve the chosen window into start/end timestamps on the scheduled
      // day. A window requires a date; clearing the date clears the window.
      let arrivalWindow: { start: Date; end: Date } | null | undefined;
      if (parsed.data.arrivalWindow === null || when === null) {
        arrivalWindow = null;
      } else if (parsed.data.arrivalWindow !== undefined && when) {
        // Anchor the band hours in the BUSINESS timezone (not UTC), matching the
        // calendar / reschedule / auto-dispatch paths — otherwise the SAME
        // "morning" band persists a different instant here (8:00Z = 3 AM ET)
        // than everywhere else (8 AM ET). Use the picked calendar day (UTC date
        // portion of the ISO scheduledDate).
        arrivalWindow = arrivalWindowUtcForBusinessDate(
          parsed.data.scheduledDate!.slice(0, 10),
          parsed.data.arrivalWindow as ArrivalWindow,
        );
      } else {
        arrivalWindow = undefined; // leave the window untouched
      }

      // When a concrete window is set, store scheduledDate AS the window start so
      // the two agree — the raw scheduledDate is UTC midnight, which in Eastern is
      // the PREVIOUS evening, so persisting it made the bot/calendar announce the
      // appointment a day early relative to the business-anchored window.
      const effectiveWhen = arrivalWindow ? arrivalWindow.start : when;

      const result = await scheduleRequest(
        session.organizationId,
        id,
        effectiveWhen,
        arrivalWindow,
      );
      if (!result.ok) {
        if (result.reason === "time_off") {
          return errorResponse(
            "That technician is off during this window.",
            "TIME_OFF",
            409,
          );
        }
        if (result.reason === "request_not_found") {
          return errorResponse("Request not found", "NOT_FOUND", 404);
        }
        // The writer is unchanged (M2 §3.2); only the copy names FieldPulse for a mapped request.
        return visitOneRefusalResponse(result.reason, {
          fieldpulse: await isFieldpulseMapped(session.organizationId, id),
        });
      }
      await logAudit({
        organizationId: session.organizationId,
        userId: session.userId,
        action: "request_scheduled",
        entity: "service_request",
        entityId: id,
        details: JSON.stringify({
          scheduledCleared: result.scheduledDate === null,
          hasArrivalWindow: result.arrivalWindowStart !== null,
        }),
      });
      calendarScheduleChanged = true;
      scheduleCleared = effectiveWhen === null;
    }

    const detail = await getRequestById(session.organizationId, id, viewer);
    if (!detail) {
      return errorResponse("Request not found", "NOT_FOUND", 404);
    }

    // One background Google Calendar reconciliation per PATCH (never blocks the
    // response; no-ops when the org isn't connected). A cancel removes the
    // event; otherwise a schedule change upserts it. syncRequestToCalendar
    // itself no-ops when the request has no arrival window.
    if (calendarCancelled || scheduleCleared) {
      after(() => deleteRequestFromCalendar(session.organizationId, id));
    } else if (calendarScheduleChanged) {
      after(() => syncRequestToCalendar(session.organizationId, id));
    }

    // Mirror the same change into FSM integrations (HCP + Fieldpulse) — never
    // blocks; no-ops when the org isn't connected. A cancellation CANCELS the
    // FSM job; a (re)schedule UPDATEs it (each push*Job function is idempotent
    // — update when already mapped). Cancel wins if both somehow apply in one
    // PATCH, matching the calendar.
    if (calendarCancelled) {
      after(() => cancelHcpJob(session.organizationId, id));
      after(() => cancelFieldpulseJob(session.organizationId, id));
    } else if (calendarScheduleChanged) {
      after(() => pushJobToHcp(session.organizationId, id));
      after(() => pushJobToFieldpulse(session.organizationId, id));
    }

    return successResponse(detail);
  } catch (error: unknown) {
    if (isDeadlock(error)) {
      return errorResponse("This job changed. Refresh and try again.", "STALE", 409);
    }
    logger.error({ error }, "Failed to update request");
    return errorResponse("Couldn’t update the request. Please try again.", "INTERNAL_ERROR", 500);
  }
}

export async function POST(
  request: Request,
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
      `admin:request-note:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = noteSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Note content is required (1–5000 chars)",
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await addRequestNote(
      session.organizationId,
      id,
      session.userId,
      parsed.data.content,
    );
    if (!result.ok) {
      return errorResponse("Request not found", "NOT_FOUND", 404);
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "request_note_added",
      entity: "service_request",
      entityId: id,
      // Note CONTENT is staff free-text — never log it in the audit details
      // (the audit viewer renders details verbatim). Record only the note id.
      details: JSON.stringify({ noteId: result.note.id }),
    });

    // Mirror the dispatcher note onto the request's FSM jobs (HCP + Fieldpulse)
    // so the field tech sees it. Background-only (after()) so a slow/down FSM
    // can never block or fail adding a note; degrade-safe + no-ops when the org
    // isn't connected or the request isn't in the FSM yet. We push the validated
    // note CONTENT (not the note id) — it's the text the tech needs.
    after(() =>
      syncJobNoteToHcp(session.organizationId, id, parsed.data.content),
    );
    after(() =>
      syncNoteToFieldpulse(session.organizationId, id, parsed.data.content),
    );

    return successResponse(result.note, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to add request note");
    return errorResponse("Couldn’t add the note. Please try again.", "INTERNAL_ERROR", 500);
  }
}
