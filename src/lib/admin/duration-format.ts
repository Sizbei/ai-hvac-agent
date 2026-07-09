/**
 * Humanize a duration in seconds for compact operational display, e.g.
 * 7500 → "2h 5m". Used by the FieldPulse metrics block on the request
 * detail sheet (status_log stage durations).
 */

/**
 * Format seconds as "Xh Ym" / "Ym" / "<1m".
 * Returns null for null/undefined/non-finite/negative input so callers can
 * hide the row entirely.
 */
export function humanizeSeconds(
  seconds: number | null | undefined,
): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes === 0) return seconds > 0 ? "<1m" : "0m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
