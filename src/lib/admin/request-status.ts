/**
 * State machine for an admin-driven service-request lifecycle.
 *
 * A request moves: pending → (scheduled) → assigned → in_progress → completed,
 * with "on_hold" as a resumable pause on any active job. Any non-final state can
 * also be cancelled. Assignment (pending/scheduled → assigned) is owned by
 * `assignTechnician` in queries.ts; THIS module governs the manual status
 * transitions a dispatcher drives from the request detail view.
 *
 * The two intermediate stages (ServiceTitan-aligned):
 *   - scheduled: booked with an arrival window, before a tech is actively on it.
 *   - on_hold:   paused (waiting on parts/customer/access); resumable.
 *
 * Centralizing the allowed edges keeps the API route, the query guard, and the
 * UI in agreement on what's legal — and makes the lost-update race safe, since
 * the DB UPDATE is guarded on the expected `from` status.
 */
import { requestStatusEnum, holdReasonEnum } from "@/lib/db/schema";

export type RequestStatus = (typeof requestStatusEnum.enumValues)[number];

/** Why a request is on hold — set when a dispatcher pauses a job. */
export const HOLD_REASONS = holdReasonEnum.enumValues;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** Allowed manual transitions, keyed by the current status. Assignment is
 * handled separately (assignTechnician); it is not a manual target here. */
const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  // A pending request can be scheduled (book an arrival window) or cancelled.
  pending: ["scheduled", "cancelled"],
  // A scheduled (but unassigned) request can start, pause, or cancel.
  scheduled: ["in_progress", "on_hold", "cancelled"],
  // An assigned request can be scheduled, started, paused, or cancelled.
  assigned: ["scheduled", "in_progress", "on_hold", "cancelled"],
  in_progress: ["on_hold", "completed", "cancelled"],
  // A paused job resumes (in_progress), can be re-scheduled, or cancelled.
  on_hold: ["in_progress", "scheduled", "cancelled"],
  completed: [],
  cancelled: [],
};

/** A status the dispatcher can set manually via the status endpoint.
 * `as const` keeps the literal element types so consumers can derive a narrow
 * union (`(typeof MANUAL_TARGET_STATUSES)[number]`) rather than the full set.
 * Assignment is a separate flow, so "assigned" is not a manual target. */
export const MANUAL_TARGET_STATUSES = [
  "scheduled",
  "in_progress",
  "on_hold",
  "completed",
  "cancelled",
] as const satisfies readonly RequestStatus[];

export function canTransition(
  from: RequestStatus,
  to: RequestStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Returns the set of statuses reachable from `from` in one manual step. */
export function allowedTransitions(
  from: RequestStatus,
): readonly RequestStatus[] {
  return TRANSITIONS[from] ?? [];
}

/** Whether a status is terminal (no further transitions). */
export function isTerminal(status: RequestStatus): boolean {
  return (TRANSITIONS[status]?.length ?? 0) === 0;
}
