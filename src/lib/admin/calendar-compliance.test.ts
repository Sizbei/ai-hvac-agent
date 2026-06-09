/**
 * Calendar-compliance integration test — "the bot respects the calendar."
 *
 * This is the contract test that proves the customer-facing window offer
 * (buildWindowPrompt) only ever surfaces arrival bands that ACTUALLY have open
 * capacity according to the pure capacity calc (computeOpenWindows). It wires the
 * two real, pure layers together exactly as the live availability path does
 * (computeOpenWindows → OpenAvailability → buildWindowPrompt) — NO mocks of the
 * pure layer, NO live DB — so a regression that lets the bot offer a fully-booked
 * band (or a fully-booked day) fails here.
 *
 * Scenarios:
 *   1. Morning fully booked, afternoon/evening open → chips drop morning, keep
 *      afternoon/evening (+ the always-present ASAP).
 *   2. A whole day fully booked → that day is skipped, the next open day offered.
 *   3. Nothing open in range → generic fallback (all four chips incl. morning).
 *   4. Offered chip VALUES are always a subset of {morning,afternoon,evening,asap}
 *      and NEVER a band whose computed `available` is 0.
 */
import { describe, it, expect } from "vitest";
import { computeOpenWindows } from "./availability";
import { businessWallClockToUtc } from "./calendar-time";
import { buildWindowPrompt } from "@/lib/ai/availability-prompt";
import type {
  AvailabilitySlot,
  OpenAvailability,
  ScheduledJob,
} from "./types";

// 2026-07-01 (Wed, EDT) and 2026-07-02 (Thu) — two consecutive working days.
const WED = "2026-07-01";
const THU = "2026-07-02";

const ALLOWED_VALUES = new Set(["morning", "afternoon", "evening", "asap"]);

/** Full-day (8am–8pm Eastern) availability slot for a tech on a weekday so every
 * band has capacity unless a booking subtracts it. */
function fullDaySlot(
  technicianId: string,
  dayOfWeek: number,
): AvailabilitySlot {
  return {
    id: `av-${technicianId}-${dayOfWeek}`,
    technicianId,
    dayOfWeek,
    startMinute: 8 * 60,
    endMinute: 20 * 60,
  };
}

/** A booked job occupying [startHour,endHour) Eastern on `isoDay` for a tech,
 * built through businessWallClockToUtc so the instants line up with the band
 * hours the capacity calc reads (DST-correct). */
function bookedJob(
  technicianId: string,
  isoDay: string,
  startHour: number,
  endHour: number,
): ScheduledJob {
  return {
    id: `job-${technicianId}-${isoDay}-${startHour}`,
    referenceNumber: "HVAC-CAP-TEST",
    status: "scheduled",
    assignedTo: technicianId,
    arrivalWindowStart: businessWallClockToUtc(isoDay, startHour, 0).toISOString(),
    arrivalWindowEnd: businessWallClockToUtc(isoDay, endHour, 0).toISOString(),
  };
}

/** Run the REAL availability pipeline a caller hits: pure capacity calc →
 * OpenAvailability envelope → prompt builder. No mocks. */
function offerFor(
  activeTechIds: readonly string[],
  availability: readonly AvailabilitySlot[],
  jobs: readonly ScheduledJob[],
  days: readonly string[],
): ReturnType<typeof buildWindowPrompt> {
  const windows = computeOpenWindows(activeTechIds, availability, jobs, days);
  const open: OpenAvailability = { days: [...days], windows };
  return buildWindowPrompt(open);
}

describe("calendar compliance — bot offers only bands with real capacity", () => {
  it("1. morning fully booked → offers afternoon/evening (+ASAP), NOT morning", () => {
    const techs = ["t1", "t2"];
    const availability = [fullDaySlot("t1", 3), fullDaySlot("t2", 3)]; // Wed
    // BOTH techs booked the morning band → morning available 0; pm/evening open.
    const jobs = [bookedJob("t1", WED, 8, 12), bookedJob("t2", WED, 8, 12)];

    const { chips } = offerFor(techs, availability, jobs, [WED]);
    const values = chips.map((c) => c.value);

    expect(values).not.toContain("morning");
    expect(values).toContain("afternoon");
    expect(values).toContain("evening");
    expect(values).toContain("asap"); // always present for urgent callers
  });

  it("2. whole day fully booked → that day skipped, next open day offered", () => {
    const techs = ["t1"];
    // Tech works Wed (3) AND Thu (4) full days.
    const availability = [fullDaySlot("t1", 3), fullDaySlot("t1", 4)];
    // The single tech is booked ALL of Wed (8–20 = every band) → Wed has no
    // open window; Thu is untouched.
    const jobs = [bookedJob("t1", WED, 8, 20)];

    const { chips, question } = offerFor(techs, availability, jobs, [WED, THU]);
    const values = chips.map((c) => c.value);

    // Wed is fully booked, so the offered day must be Thu — the prompt names it.
    expect(question).toContain("Jul 2");
    // Thu is wide open, so all three bands are bookable there.
    expect(values).toEqual(
      expect.arrayContaining(["morning", "afternoon", "evening", "asap"]),
    );
  });

  it("3. nothing open in range → generic fallback (all four chips incl. morning)", () => {
    const techs = ["t1"];
    const availability = [fullDaySlot("t1", 3)]; // Wed only
    // Tech booked the entire Wed (8–20) → no open windows anywhere in range.
    const jobs = [bookedJob("t1", WED, 8, 20)];

    const { chips, question } = offerFor(techs, availability, jobs, [WED]);
    const values = chips.map((c) => c.value);

    // Generic fallback copy + the full four-chip set (morning included again).
    expect(question).toBe(
      "When works best for a visit? (We'll confirm the exact time.)",
    );
    expect(values).toEqual(["morning", "afternoon", "evening", "asap"]);
  });

  it("3b. no availability configured at all → generic fallback", () => {
    // No slots ⇒ computeOpenWindows returns [] ⇒ no bookable day ⇒ fallback.
    const { chips } = offerFor(["t1"], [], [], [WED]);
    expect(chips.map((c) => c.value)).toEqual([
      "morning",
      "afternoon",
      "evening",
      "asap",
    ]);
  });

  it("4. offered values are always a subset of the enum and never a 0-available band", () => {
    // A mixed scenario across two days with partial bookings, so the offer has to
    // actually filter: Wed morning full (both booked), Wed afternoon half-open;
    // evening open. Whatever day/bands buildWindowPrompt picks, assert the
    // invariant against the SAME capacity data the offer was derived from.
    const techs = ["t1", "t2"];
    const availability = [
      fullDaySlot("t1", 3),
      fullDaySlot("t2", 3),
      fullDaySlot("t1", 4),
      fullDaySlot("t2", 4),
    ];
    const jobs = [
      bookedJob("t1", WED, 8, 12),
      bookedJob("t2", WED, 8, 12), // Wed morning fully booked
      bookedJob("t1", WED, 12, 16), // Wed afternoon: t1 booked, t2 free
    ];
    const days = [WED, THU];

    const windows = computeOpenWindows(techs, availability, jobs, days);
    const open: OpenAvailability = { days: [...days], windows };
    const { chips } = buildWindowPrompt(open);

    // Build a lookup of available counts for the chosen day so we can assert no
    // offered band had available === 0. The offer surfaces the FIRST day with any
    // open band; derive which day that is the same way buildWindowPrompt does.
    const offeredDay = days.find((d) =>
      windows.some((w) => w.day === d && w.available > 0),
    );
    expect(offeredDay).toBeDefined();
    const availByBand = new Map(
      windows
        .filter((w) => w.day === offeredDay)
        .map((w) => [w.window, w.available] as const),
    );

    for (const chip of chips) {
      // Invariant A: only ever the known enum values.
      expect(ALLOWED_VALUES.has(chip.value)).toBe(true);
      // Invariant B: ASAP is always allowed; any real band offered must have
      // available > 0 on the offered day (never a fully-booked band).
      if (chip.value !== "asap") {
        expect(availByBand.get(chip.value) ?? 0).toBeGreaterThan(0);
      }
    }
    // And specifically: Wed morning (fully booked) must NOT be offered.
    expect(chips.map((c) => c.value)).not.toContain("morning");
  });
});
