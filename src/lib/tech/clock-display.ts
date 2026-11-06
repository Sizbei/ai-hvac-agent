/**
 * Pure copy for the technician clocks: the read-only "Time on this job" card
 * (status taps are the only job clock) and the day clock on /tech/jobs.
 * No React, no fetch — safe for client code and plain vitest.
 */

/** Whole minutes as "1h 05m"-style "1h 5m", or "14m" under an hour. */
export function formatMinutes(mins: number): string {
  const safe = Math.max(0, Math.floor(mins));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** 3725 seconds -> "1:02:05"; under an hour -> "2:05". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(h > 0 ? 2 : 1, "0");
  const sec = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}

/** "9:12 AM" in the given zone (device zone when omitted). */
export function formatClockTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

export const JOB_CLOCK_NOT_STARTED = "Starts when you tap I've arrived.";

export const JOB_CLOCK_NONE = "No time logged on this job.";

/**
 * The one line on the read-only job time card. `totalMinutes` is the
 * technician's closed time on this job and `closedEntries` how many closed
 * entries it came from (a pause inside the first minute logs 0m but is still
 * earlier time, so the card must not read "Starts when…").
 * - an open entry: "On the clock since 9:12 AM · 14m", plus "(44m on this job)"
 *   when there is earlier time
 * - a closed job: "Total 1h 5m"
 * - closed time only: "1h 5m so far"
 * - nothing yet: "Starts when you tap I've arrived."
 */
export function jobClockLine(input: {
  readonly openSince: string | null;
  readonly totalMinutes: number;
  readonly closedEntries?: number;
  readonly jobClosed?: boolean;
  readonly nowMs: number;
  readonly timeZone?: string;
}): string {
  const { openSince, totalMinutes, nowMs, timeZone } = input;
  const earlier = totalMinutes > 0 || (input.closedEntries ?? 0) > 0;
  if (openSince) {
    const elapsed = Math.max(0, Math.floor((nowMs - new Date(openSince).getTime()) / 60000));
    const line = `On the clock since ${formatClockTime(openSince, timeZone)} · ${formatMinutes(elapsed)}`;
    return earlier ? `${line} (${formatMinutes(totalMinutes + elapsed)} on this job)` : line;
  }
  if (input.jobClosed) return earlier ? `Total ${formatMinutes(totalMinutes)}` : JOB_CLOCK_NONE;
  if (earlier) return `${formatMinutes(totalMinutes)} so far`;
  return JOB_CLOCK_NOT_STARTED;
}

/** Day clock copy: the running label (null while out) and the button text. */
export function dayClockText(input: {
  readonly clockInAt: string | null | undefined;
  readonly nowMs: number;
  readonly pending: boolean;
}): { readonly running: string | null; readonly button: string } {
  const { clockInAt, nowMs, pending } = input;
  if (typeof clockInAt === "string") {
    return {
      running: `Day clock ${formatElapsed(nowMs - new Date(clockInAt).getTime())}`,
      button: pending ? "Clocking out…" : "Clock out",
    };
  }
  return { running: null, button: pending ? "Clocking in…" : "Clock in for the day" };
}
