/**
 * Open-availability query layer — Stage 5.
 *
 * Bridges the PURE open-window math (availability.ts) to real data, READING
 * THROUGH the SchedulingSource seam (scheduling-source.ts) for both availability
 * (working hours) and booked jobs. The set of bookable technicians comes from the
 * users table (active technicians). Everything is tenant-scoped.
 *
 * ┌─ HCP SEAM ────────────────────────────────────────────────────────────────┐
 * │ getOpenAvailability resolves its facts via getSchedulingSource(orgId): the  │
 * │ DB source today, an HCP source once the MAX-plan API key unblocks it. When  │
 * │ HCP is the source of truth, getAvailability/getJobs return HCP-derived rows │
 * │ in the SAME shapes (AvailabilitySlot / ScheduledJob) and this function — and │
 * │ the pure compute — need NO change. The active-technician roster could also  │
 * │ move behind the seam later; it's read from users here because that's where  │
 * │ bookable staff live natively.                                               │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { getSchedulingSource } from "./scheduling-source";
import { computeOpenWindows } from "./availability";
import {
  BUSINESS_TIME_ZONE,
  businessWallClockToUtc,
  toBusinessWallClock,
} from "./calendar-time";
import type { OpenAvailability } from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The active technician ids for an org — the bookable staff whose hours count
 * toward capacity. Tenant-scoped; ids only (no names) so nothing PII flows into
 * the open-window aggregation. */
async function getActiveTechnicianIds(
  organizationId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      withTenant(
        users,
        organizationId,
        eq(users.role, "technician"),
        eq(users.isActive, true),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * The N consecutive business-tz ISO dates starting at `startIsoDay` (inclusive).
 * Derived by stepping a day at a time from the day's Eastern NOON instant, so a
 * DST transition never drops or doubles a date. Pure date math on business-tz
 * instants — the same convention businessWeekDates uses.
 */
export function businessDaysFrom(
  startIsoDay: string,
  count: number,
): readonly string[] {
  const days: string[] = [];
  // Anchor at Eastern noon so adding 24h never lands on a DST-shifted midnight
  // that would skip/repeat a calendar day.
  let cursor = businessWallClockToUtc(startIsoDay, 12, 0);
  for (let i = 0; i < count; i += 1) {
    const wall = toBusinessWallClock(cursor);
    const mm = String(wall.month).padStart(2, "0");
    const dd = String(wall.day).padStart(2, "0");
    days.push(`${wall.year}-${mm}-${dd}`);
    cursor = new Date(cursor.getTime() + MS_PER_DAY);
  }
  return days;
}

/** The business-tz ISO date (YYYY-MM-DD) the given instant falls on, in Eastern. */
export function businessTodayIso(now: Date): string {
  const wall = toBusinessWallClock(now);
  const mm = String(wall.month).padStart(2, "0");
  const dd = String(wall.day).padStart(2, "0");
  return `${wall.year}-${mm}-${dd}`;
}

/** The IANA business timezone the availability surface renders in (Eastern). */
export const AVAILABILITY_TIME_ZONE = BUSINESS_TIME_ZONE;

/**
 * Compute the open, bookable windows for an org across `days`, PII-free.
 *
 * Reads availability + jobs through the scheduling source (HCP seam) and the
 * active-technician roster, then delegates to the pure computeOpenWindows. The
 * jobs range spans from the first day's Eastern midnight to the last day's
 * Eastern end-of-day, so every job that could overlap any requested band is in
 * scope; the pure compute does the precise per-band overlap.
 *
 * `days` MUST be a non-empty ascending list of business-tz ISO dates (the route
 * validates + bounds the count before calling). Returns counts only — never a
 * technician name or id.
 */
export async function getOpenAvailability(
  organizationId: string,
  days: readonly string[],
): Promise<OpenAvailability> {
  if (days.length === 0) {
    return { days: [], windows: [] };
  }

  const source = getSchedulingSource(organizationId);
  const firstDay = days[0]!;
  const lastDay = days[days.length - 1]!;
  // [first day's Eastern midnight, day-after-last's Eastern midnight) — a
  // half-open instant range wide enough to include every job touching any band.
  const rangeStart = businessWallClockToUtc(firstDay, 0, 0);
  const lastMidnight = businessWallClockToUtc(lastDay, 0, 0);
  const rangeEnd = new Date(lastMidnight.getTime() + MS_PER_DAY);

  const [activeTechIds, availability, jobs] = await Promise.all([
    getActiveTechnicianIds(organizationId),
    source.getAvailability(),
    source.getJobs(rangeStart.toISOString(), rangeEnd.toISOString()),
  ]);

  const windows = computeOpenWindows(activeTechIds, availability, jobs, days);
  return { days: [...days], windows };
}
