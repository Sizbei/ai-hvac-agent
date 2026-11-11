/**
 * What the request sheet shows and offers for the request's current visit
 * (current-visit.ts). Pure, so the sheet's branching is unit-tested.
 *
 * - "request": visit #1 (or no visit) is current. The sheet's technician and
 *   date/window controls edit it, as before.
 * - "visit":   a later visit is current. The request-level controls would
 *   rewrite visit #1 (the server refuses), so they give way to the Visits
 *   section, and progress (en route / arrived / started) comes from the
 *   technician's app on that visit.
 * - "ended":   a hold ended the visit. Nothing is booked; the way forward is
 *   "Schedule next visit", and a bare status resume is not offered.
 */
import type { AdminRequestDetail } from "./types";
import { RESUME_TARGET_STATUSES, type RequestStatus } from "./request-status";

export interface SheetVisitView {
  readonly mode: "request" | "visit" | "ended";
  /** Who goes on the current visit (for "ended": who it was booked with). */
  readonly technicianName: string | null;
  readonly arrivalWindowStart: string | null;
  readonly arrivalWindowEnd: string | null;
  /** The request-level assign/reassign and date/window controls apply. */
  readonly requestControls: boolean;
  /** Status buttons not to offer. */
  readonly hiddenTransitions: readonly RequestStatus[];
  /** Plain-language line explaining the state, or null. */
  readonly notice: string | null;
}

type DetailFields = Pick<
  AdminRequestDetail,
  "currentVisit" | "assignedToName" | "arrivalWindowStart" | "arrivalWindowEnd"
>;

export function sheetVisitView(detail: DetailFields): SheetVisitView {
  const v = detail.currentVisit;
  if (v.kind === "request") {
    return {
      mode: "request",
      technicianName: detail.assignedToName,
      arrivalWindowStart: detail.arrivalWindowStart,
      arrivalWindowEnd: detail.arrivalWindowEnd,
      requestControls: true,
      hiddenTransitions: [],
      notice: null,
    };
  }
  if (v.kind === "ended") {
    return {
      mode: "ended",
      technicianName: v.technicianName,
      arrivalWindowStart: v.arrivalWindowStart,
      arrivalWindowEnd: v.arrivalWindowEnd,
      requestControls: false,
      hiddenTransitions: RESUME_TARGET_STATUSES,
      notice: "This visit ended when the request was put on hold. Schedule the next visit to send someone.",
    };
  }
  return {
    mode: "visit",
    technicianName: v.technicianName,
    arrivalWindowStart: v.arrivalWindowStart,
    arrivalWindowEnd: v.arrivalWindowEnd,
    requestControls: false,
    // The office's progress taps mirror onto visit #1 only; on a later visit
    // they would move the request while the technician's row stays put.
    hiddenTransitions: RESUME_TARGET_STATUSES,
    notice: `Visit #${v.appointmentNumber} is the current visit. Change its time or technicians under Visits.`,
  };
}

/**
 * The cancel confirmation's body: only mention a technician when one is on it,
 * and say so when the cancel also reaches the linked FieldPulse job.
 */
export function cancelRequestDescription(hasTechnician: boolean, inFieldpulse = false): string {
  const base = hasTechnician
    ? "The technician will see it as cancelled."
    : "It moves to Cancelled and stays in the request history.";
  return inFieldpulse ? `${base} This also cancels the job in FieldPulse.` : base;
}
