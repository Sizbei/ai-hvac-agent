/**
 * State machine for an admin-driven service-request lifecycle.
 *
 * A request moves: pending → assigned → in_progress → completed. Any non-final
 * state can also be cancelled. Assignment (pending/assigned → assigned) is owned
 * by `assignTechnician` in queries.ts; THIS module governs the manual status
 * transitions a dispatcher drives from the request detail view.
 *
 * Centralizing the allowed edges keeps the API route, the query guard, and the
 * UI in agreement on what's legal — and makes the lost-update race safe, since
 * the DB UPDATE is guarded on the expected `from` status.
 */
import { requestStatusEnum } from "@/lib/db/schema";

export type RequestStatus = (typeof requestStatusEnum.enumValues)[number];

/** Allowed manual transitions, keyed by the current status. Assignment is
 * handled separately (assignTechnician); it is not a manual target here. */
const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  pending: ["cancelled"],
  assigned: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/** A status the dispatcher can set manually via the status endpoint.
 * `as const` keeps the literal element types so consumers can derive a narrow
 * union (`(typeof MANUAL_TARGET_STATUSES)[number]`) rather than the full set. */
export const MANUAL_TARGET_STATUSES = [
  "in_progress",
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
