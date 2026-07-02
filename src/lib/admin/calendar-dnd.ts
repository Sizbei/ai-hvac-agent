/**
 * Shared types + id codecs for the drag-to-reschedule calendar (S3).
 *
 * @dnd-kit identifies draggables/droppables by a string/number id and lets each
 * carry an arbitrary `data` payload. We use the `data` payload (typed here) as
 * the source of truth and keep ids as opaque, collision-free strings. Pure
 * module — no React, no DOM — so the encode/decode is unit-testable and safe to
 * import from server or client.
 */
import type { RescheduleWindowRow } from "./calendar-time";

/** The draggable payload: which request is being moved. */
export interface DragJobData {
  readonly kind: "job";
  readonly requestId: string;
  /** Current arrival-window start (ISO) if placed, else null (from the queue). */
  readonly currentStartIso: string | null;
}

/** The droppable payload: a window band on a given day, for a given scope. */
export interface DropZoneData {
  readonly kind: "window";
  /** The lane this band belongs to: a technicianId, or the literal "unassigned".
   * Drives S4 drag-to-assign — a drop into a different tech's lane reassigns the
   * job. (Week-view bands are all registered under "unassigned", so a week drop
   * is reschedule-only.) */
  readonly scope: string;
  /** Business-tz day (YYYY-MM-DD) this band belongs to. */
  readonly isoDay: string;
  readonly window: RescheduleWindowRow;
}

/** The droppable payload for the "Unscheduled" queue panel — a drop here clears
 * the job's placement and returns it to the queue. */
export interface UnscheduledDropZoneData {
  readonly kind: "unscheduled";
}

/** Stable droppable id for the single Unscheduled-queue zone. */
export const UNSCHEDULED_DROP_ID = "drop:unscheduled";

/** Any drop target on the calendar: a window band or the unscheduled queue. */
export type CalendarDropData = DropZoneData | UnscheduledDropZoneData;

/** Stable droppable id for a (scope, day, window) band. Scope is the lane —
 * a technicianId or the literal "unassigned" — kept in the id so two lanes on the
 * same day/window don't collide. */
export function dropZoneId(
  scope: string,
  isoDay: string,
  window: RescheduleWindowRow,
): string {
  return `drop:${scope}:${isoDay}:${window}`;
}

/** Stable draggable id for a job. Job ids are UUIDs, already unique. */
export function dragJobId(requestId: string): string {
  return `job:${requestId}`;
}
