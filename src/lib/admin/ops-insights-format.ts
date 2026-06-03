/**
 * Pure presentation helpers for the Operations Insights dashboard. Extracted
 * from the section component so they can be unit-tested in isolation.
 */

/** Format integer cents as a whole-dollar amount with thousands separators. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

/** 12-hour clock label for an hour-of-day (0–23): 0 → "12a", 12 → "12p". */
export function hourLabel(hour: number): string {
  const period = hour < 12 ? "a" : "p";
  const base = hour % 12 === 0 ? 12 : hour % 12;
  return `${base}${period}`;
}
