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

/**
 * A readable name for an IANA zone, e.g. "America/New_York" → "Eastern Time".
 * Falls back to the zone id if the runtime has no generic name for it.
 */
export function timeZoneLabel(timeZone: string, at: Date = new Date()): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    return name ?? timeZone;
  } catch {
    return timeZone;
  }
}

const URGENCY_ORDER = ["emergency", "high", "medium", "low"];

/** Urgency rows most-urgent first (emergency, high, medium, low), unknown keys last. */
export function sortByUrgency<T extends { readonly key: string }>(rows: readonly T[]): T[] {
  const rank = (k: string) => {
    const i = URGENCY_ORDER.indexOf(k);
    return i === -1 ? URGENCY_ORDER.length : i;
  };
  return [...rows].sort((a, b) => rank(a.key) - rank(b.key));
}

/** The first busiest hour (earliest on a tie), or null when there is no data. */
export function peakHour(rows: readonly { readonly hour: number; readonly count: number }[]): number | null {
  let best: { hour: number; count: number } | null = null;
  for (const r of rows) if (r.count > 0 && (!best || r.count > best.count)) best = r;
  return best ? best.hour : null;
}
