/**
 * Initial values for the request sheet's "Scheduled date + arrival window"
 * controls, read from what is actually stored — so the controls agree with the
 * "Arrival window: …" line and an untouched Save is a no-op.
 *
 * Every live write path anchors band hours in the business timezone
 * (arrivalWindowUtcForBusinessDate), so the date is the BUSINESS date of the
 * window start (not its UTC date, which is a day ahead for an evening window)
 * and the window is the band whose business-time bounds match exactly. A
 * window that matches no band (a seeded 11:03 PM slot, a legacy UTC window)
 * returns `window: null` and the picker asks for a choice instead of
 * pretending it is "Anytime".
 */
import { ARRIVAL_WINDOWS, type ArrivalWindow } from "@/lib/admin/arrival-window";
import { arrivalWindowUtcForBusinessDate, businessIsoDate } from "@/lib/admin/calendar-time";

export interface ScheduleInputs {
  /** YYYY-MM-DD business date, or "" when nothing is scheduled. */
  readonly date: string;
  readonly window: ArrivalWindow | null;
}

function validDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function scheduleInputsFrom(
  scheduledDate: string | null | undefined,
  windowStart: string | null | undefined,
  windowEnd: string | null | undefined,
): ScheduleInputs {
  const start = validDate(windowStart);
  const end = validDate(windowEnd);
  if (start && end) {
    const date = businessIsoDate(start);
    const window =
      ARRIVAL_WINDOWS.find((w) => {
        const band = arrivalWindowUtcForBusinessDate(date, w);
        return band.start.getTime() === start.getTime() && band.end.getTime() === end.getTime();
      }) ?? null;
    return { date, window };
  }
  const scheduled = validDate(scheduledDate);
  // A date with no window is stored at UTC midnight of the chosen day.
  return { date: scheduled ? scheduled.toISOString().slice(0, 10) : "", window: null };
}

/** Save is offered only for a complete, changed choice. */
export function canSaveSchedule(current: ScheduleInputs, chosen: ScheduleInputs): boolean {
  if (!chosen.date || !chosen.window) return false;
  return chosen.date !== current.date || chosen.window !== current.window;
}
