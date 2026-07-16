/**
 * Open-window computation — the Stage 5 customer-facing slot model.
 *
 * "Open windows" = technician AVAILABILITY (recurring working hours) MINUS
 * already-booked time (active jobs with an arrival window), aggregated across
 * technicians into bookable bands (morning/afternoon/evening) for one or more
 * business days. The customer chat/widget offers these as the concrete times a
 * caller can pick, instead of the old "we'll confirm the time" placeholder.
 *
 * This module is PURE: it takes already-fetched availability slots + booked jobs
 * and the set of active technician ids, and returns counts. No I/O, no Date.now()
 * — the DB read lives in availability-queries.ts (behind the scheduling-source
 * seam), so DST and tenancy are handled by the callers/helpers it composes, and
 * this logic unit-tests deterministically.
 *
 * PII GUARANTEE: the output carries ONLY counts (capacity / available) per
 * day+window. It never returns a technician name or id — the public availability
 * endpoint returns this verbatim, so leaking a count is the worst case, never a
 * staff identity.
 *
 * ┌─ HCP SEAM ────────────────────────────────────────────────────────────────┐
 * │ Availability + jobs come through the SchedulingSource (scheduling-source.ts)│
 * │ — our DB today, Housecall Pro tomorrow. This pure compute consumes the      │
 * │ source's already-fetched data, so an HCP-backed source that returns the     │
 * │ same AvailabilitySlot / ScheduledJob shapes needs NO change here.           │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
import type {
  AvailabilitySlot,
  CapacityReservationSlot,
  OpenWindow,
  ScheduledJob,
} from "./types";
import type { ArrivalWindow } from "./arrival-window";
import { arrivalWindowHours } from "./arrival-window";
import {
  businessWeekday,
  isWindowWithinAvailability,
} from "./availability-coverage";
import {
  businessIsoDate,
  businessMinutesOfDay,
  RESCHEDULE_WINDOW_ROWS,
  type RescheduleWindowRow,
} from "./calendar-time";

const MINUTES_PER_HOUR = 60;

/**
 * Which discrete band a job's arrival window occupies on a given business day —
 * i.e. which band(s) it BOOKS, so we can subtract that tech from the band's
 * capacity. A job overlaps a band when its Eastern wall-clock span intersects the
 * band's [startHour, endHour). We read the job's start/end minutes in the business
 * timezone (DST-correct via businessMinutesOfDay) and test half-open overlap
 * against each band. A wide window (e.g. an `anytime` 8–20 job) overlaps all three
 * bands and so occupies the tech across the whole day.
 *
 * `isoDay` is the business day we're testing; a job whose business date doesn't
 * match the day contributes nothing (it's a different day's booking).
 */
function bookedBandsForJob(
  job: ScheduledJob,
  isoDay: string,
): ReadonlySet<RescheduleWindowRow> {
  // A null window means the job has no placement yet — it contributes no bands.
  if (!job.arrivalWindowStart || !job.arrivalWindowEnd) return new Set();
  const start = new Date(job.arrivalWindowStart);
  const end = new Date(job.arrivalWindowEnd);
  // Defensive: a malformed window books nothing rather than throwing.
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return new Set();
  }
  // Only jobs landing on THIS business day count toward the day's bookings.
  if (businessIsoDate(start) !== isoDay) return new Set();

  const startMin = businessMinutesOfDay(start);
  // End may roll to the next business day (or read earlier than start after a
  // midnight cross); clamp to end-of-day so an evening job still books evening.
  const rawEndMin = businessMinutesOfDay(end);
  const endMin = rawEndMin <= startMin ? 24 * MINUTES_PER_HOUR : rawEndMin;

  const booked = new Set<RescheduleWindowRow>();
  for (const band of RESCHEDULE_WINDOW_ROWS) {
    const [bandStartHour, bandEndHour] = arrivalWindowHours(band);
    const bandStart = bandStartHour * MINUTES_PER_HOUR;
    const bandEnd = bandEndHour * MINUTES_PER_HOUR;
    // Half-open overlap: existing.start < band.end AND band.start < existing.end.
    if (startMin < bandEnd && bandStart < endMin) booked.add(band);
  }
  return booked;
}

/**
 * Compute the open (bookable) windows across `days`, aggregated across the active
 * technicians, PII-free.
 *
 * For each business day and each band (morning/afternoon/evening):
 *  - CAPACITY = active technicians whose recurring working hours fully cover the
 *    band that weekday (reusing isWindowWithinAvailability — the SAME coverage
 *    rule the dispatch board enforces against, so customer-facing availability
 *    and admin enforcement never disagree).
 *  - BOOKED = of those covered technicians, how many already have an active job
 *    overlapping the band on that day (bookedBandsForJob) — i.e. PLACED bookings.
 *  - RESERVED (in-flight) = active capacity_reservations for the (day, band)
 *    whose request is NOT already counted as a placed job. Fresh confirm-time
 *    holds live here BEFORE a technician is assigned, plugging the gap where an
 *    unassigned booking wouldn't count toward BOOKED and could be over-promised.
 *  - AVAILABLE = capacity − booked − reserved, floored at 0.
 *
 * DEDUPE / COUNTING RULE (no double-counting): a request is counted ONCE.
 *   • ASSIGNED jobs are the source of truth for PLACED bookings (BOOKED).
 *   • RESERVATIONS are the source of truth for IN-FLIGHT bookings (no tech yet).
 * A reservation is normally released once its request is placed/cancelled/
 * unscheduled, so the two sets are disjoint. As defense-in-depth against a
 * best-effort release that failed, a reservation whose service_request_id
 * matches an assigned overlapping job in the SAME band is treated as already
 * counted (via BOOKED) and excluded from RESERVED — never added on top.
 *
 * Only bands with capacity > 0 are returned (a band no one works is not a "0
 * available" slot to show a customer — it simply isn't offered). Output is
 * ordered day-then-window for a stable, render-ready list.
 *
 * `activeTechIds` scopes the aggregation to bookable staff (active technicians);
 * availability/job rows for anyone outside the set are ignored, so a deactivated
 * tech's stale hours never inflate capacity.
 */
export function computeOpenWindows(
  activeTechIds: readonly string[],
  availability: readonly AvailabilitySlot[],
  jobs: readonly ScheduledJob[],
  days: readonly string[],
  // Active confirm-time holds. Optional/defaulted so callers/tests that predate
  // the reservation layer keep working (a booking then only counts once placed).
  reservations: readonly CapacityReservationSlot[] = [],
): readonly OpenWindow[] {
  const activeSet = new Set(activeTechIds);
  // Pre-group availability by tech so the per-band coverage test only sees one
  // technician's slots (and only active ones).
  const slotsByTech = new Map<string, AvailabilitySlot[]>();
  for (const slot of availability) {
    if (!activeSet.has(slot.technicianId)) continue;
    const bucket = slotsByTech.get(slot.technicianId);
    if (bucket) bucket.push(slot);
    else slotsByTech.set(slot.technicianId, [slot]);
  }

  const out: OpenWindow[] = [];
  for (const day of days) {
    // Touch businessWeekday once per day to fail fast on a malformed date the
    // same way isWindowWithinAvailability would (keeps the loop DST-correct).
    businessWeekday(day);
    for (const band of RESCHEDULE_WINDOW_ROWS) {
      // Techs who are working this band this day.
      const coveringTechs = activeTechIds.filter((techId) =>
        isWindowWithinAvailability(
          slotsByTech.get(techId) ?? [],
          day,
          band as ArrivalWindow,
        ),
      );
      const capacity = coveringTechs.length;
      if (capacity === 0) continue;

      // Of the covering techs, how many are already booked into this band today
      // (PLACED bookings). Track the request ids so a lingering reservation for
      // an already-placed request is deduped out of the in-flight count below.
      const bookedTechs = new Set<string>();
      const placedRequestIds = new Set<string>();
      for (const job of jobs) {
        if (!job.assignedTo || !activeSet.has(job.assignedTo)) continue;
        if (!coveringTechs.includes(job.assignedTo)) continue;
        if (bookedBandsForJob(job, day).has(band)) {
          bookedTechs.add(job.assignedTo);
          placedRequestIds.add(job.id);
        }
      }
      const booked = bookedTechs.size;

      // In-flight holds for this band whose request isn't already placed (dedupe
      // by request id — a null-linked hold is always in-flight).
      let reserved = 0;
      for (const r of reservations) {
        if (r.day !== day || r.window !== band) continue;
        if (r.serviceRequestId && placedRequestIds.has(r.serviceRequestId)) {
          continue;
        }
        reserved += 1;
      }

      const available = Math.max(0, capacity - booked - reserved);
      out.push({ day, window: band, capacity, booked, available });
    }
  }
  return out;
}
