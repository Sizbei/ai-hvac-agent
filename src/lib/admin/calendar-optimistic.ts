/**
 * Pure optimistic-move helper for the drag-to-reschedule calendar (S3).
 *
 * Given the current board and a move (job → scope/day/window), produce the NEW
 * board immediably so the UI can reflect the drop before the server confirms.
 * The caller rolls back to the prior board if the network call fails. Immutable:
 * we never mutate the input — every lane/list is rebuilt — matching the codebase's
 * immutability rule and keeping React state updates safe.
 *
 * The job may originate from any lane, the unassigned pile, OR the unscheduled
 * queue; we search all three, remove it, rewrite its window, and place it into the
 * destination lane (a technician lane or the unassigned pile). Window instants are
 * resolved in the BUSINESS timezone so the optimistic position matches where the
 * card was dropped on the Eastern grid.
 */
import type { SchedulingCalendar, DashboardRequest } from "./types";
import type { ArrivalWindow } from "./arrival-window";
import { arrivalWindowUtcForBusinessDate } from "./calendar-time";

/** The literal scope id for the unassigned (placed-but-no-tech) lane. */
export const UNASSIGNED_SCOPE = "unassigned";

interface OptimisticMove {
  readonly requestId: string;
  /** Destination lane: a technicianId, or UNASSIGNED_SCOPE. */
  readonly scope: string;
  readonly isoDay: string;
  readonly window: ArrivalWindow;
}

/** Find a job by id across lanes, unassigned, and the unscheduled queue. */
function findJob(
  calendar: SchedulingCalendar,
  requestId: string,
): DashboardRequest | null {
  for (const lane of calendar.lanes) {
    const hit = lane.jobs.find((j) => j.id === requestId);
    if (hit) return hit;
  }
  return (
    calendar.unassigned.find((j) => j.id === requestId) ??
    calendar.unscheduled.find((j) => j.id === requestId) ??
    null
  );
}

/**
 * The scope (lane) a job CURRENTLY occupies: the technicianId of the lane it sits
 * in, or UNASSIGNED_SCOPE if it's in the unassigned pile or still in the queue.
 *
 * Reschedule moves the WHEN (day/window) but NEVER the WHO — the server's
 * rescheduleRequest leaves assignedTo untouched. The week view's droppable bands
 * can't carry a per-technician scope (a week column stacks every lane's jobs), so
 * the drop handler must resolve the destination lane from the job's existing
 * placement rather than the drop zone. Returns null when the job isn't on the
 * board (caller skips the move).
 */
export function currentScopeOf(
  calendar: SchedulingCalendar,
  requestId: string,
): string | null {
  for (const lane of calendar.lanes) {
    if (lane.jobs.some((j) => j.id === requestId)) return lane.technicianId;
  }
  if (
    calendar.unassigned.some((j) => j.id === requestId) ||
    calendar.unscheduled.some((j) => j.id === requestId)
  ) {
    return UNASSIGNED_SCOPE;
  }
  return null;
}

/** Window-start ascending; jobs without a start sort last (shouldn't occur here). */
function byWindowStart(a: DashboardRequest, b: DashboardRequest): number {
  const as = a.arrivalWindowStart ?? "";
  const bs = b.arrivalWindowStart ?? "";
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/**
 * Apply an optimistic reschedule to the board. Returns the new board, or the
 * SAME reference when the job can't be found (nothing to do — caller skips).
 */
export function applyOptimisticReschedule(
  calendar: SchedulingCalendar,
  move: OptimisticMove,
): SchedulingCalendar {
  const job = findJob(calendar, move.requestId);
  if (!job) return calendar;

  const { start, end } = arrivalWindowUtcForBusinessDate(
    move.isoDay,
    move.window,
  );
  const moved: DashboardRequest = {
    ...job,
    arrivalWindowStart: start.toISOString(),
    arrivalWindowEnd: end.toISOString(),
  };

  // Remove the job from every source list.
  const remove = (list: readonly DashboardRequest[]) =>
    list.filter((j) => j.id !== move.requestId);

  const lanes = calendar.lanes.map((lane) => {
    if (lane.technicianId === move.scope) {
      return {
        ...lane,
        jobs: [...remove(lane.jobs), moved].sort(byWindowStart),
      };
    }
    return { ...lane, jobs: remove(lane.jobs) };
  });

  const intoUnassigned = move.scope === UNASSIGNED_SCOPE;
  const unassigned = intoUnassigned
    ? [...remove(calendar.unassigned), moved].sort(byWindowStart)
    : remove(calendar.unassigned);

  // It always leaves the unscheduled queue once placed with a window.
  const unscheduled = remove(calendar.unscheduled);

  return { ...calendar, lanes, unassigned, unscheduled };
}

/**
 * Apply an optimistic UNSCHEDULE: pull the job out of whatever lane / unassigned
 * pile it's in, clear its window + assignee, and drop it into the unscheduled
 * queue. Inverse of applyOptimisticReschedule. Returns the SAME reference when
 * the job can't be found (nothing to do — caller skips).
 */
export function applyOptimisticUnschedule(
  calendar: SchedulingCalendar,
  requestId: string,
): SchedulingCalendar {
  const job = findJob(calendar, requestId);
  if (!job) return calendar;

  const cleared: DashboardRequest = {
    ...job,
    arrivalWindowStart: null,
    arrivalWindowEnd: null,
    assignedToName: null,
  };

  const remove = (list: readonly DashboardRequest[]) =>
    list.filter((j) => j.id !== requestId);

  const lanes = calendar.lanes.map((lane) => ({
    ...lane,
    jobs: remove(lane.jobs),
  }));
  const unassigned = remove(calendar.unassigned);
  const unscheduled = [...remove(calendar.unscheduled), cleared];

  return { ...calendar, lanes, unassigned, unscheduled };
}
