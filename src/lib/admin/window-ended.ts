/**
 * "Has this arrival window already ended?" — shared by the New request and
 * Add visit pickers (grey the band out) and their routes (refuse it). Pure and
 * client-safe. A window that is under way (started, not over) is still bookable.
 */
import { arrivalWindowUtcForBusinessDate } from "@/lib/admin/calendar-time";
import type { ArrivalWindow } from "@/lib/admin/arrival-window";

export const WINDOW_ENDED_MESSAGE = "That arrival window has already ended. Pick a later one.";

/** True once a band on a business-tz day has fully ended at `now`. */
export function windowHasEnded(isoDay: string, window: ArrivalWindow, now: Date): boolean {
  return arrivalWindowUtcForBusinessDate(isoDay, window).end.getTime() <= now.getTime();
}

/** Same check for a raw window end (visits send instants, not a band name). */
export function instantHasPassed(endIso: string, now: Date): boolean {
  const end = Date.parse(endIso);
  return Number.isFinite(end) && end <= now.getTime();
}
