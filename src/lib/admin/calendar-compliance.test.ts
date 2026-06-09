/**
 * Calendar-compliance integration test — "the bot never over-promises timing."
 *
 * Policy: the customer-facing window offer (buildWindowPrompt) must NOT surface
 * concrete dates, openings, or any committed time/window. The bot asks a soft
 * time-of-day PREFERENCE only; the team coordinates the actual time later. This
 * test wires the real pure capacity layer (computeOpenWindows) into the prompt
 * builder exactly as the live path does, and proves that NO MATTER what the
 * calendar looks like — wide open, partially booked, or fully booked — the
 * customer prompt is identical and leaks nothing about capacity or dates.
 *
 * (computeOpenWindows itself is still exercised for admin scheduling; its
 * capacity math is covered by availability.test.ts. Here we only assert the
 * customer prompt is calendar-INDEPENDENT.)
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

const EXPECTED_CHIPS = ["morning", "afternoon", "evening", "asap"];

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

/** Assert a prompt is the calendar-independent soft-preference prompt: no date,
 * no openings, no time commitment, and exactly the four preference chips. */
function expectSoftPreference(result: ReturnType<typeof buildWindowPrompt>) {
  expect(result.question).toMatch(/preference on time of day/i);
  expect(result.question).toMatch(/team coordinates the actual time/i);
  expect(result.question).not.toMatch(/Jul \d/);
  expect(result.question).not.toMatch(/next opening/i);
  expect(result.question).not.toMatch(/confirm the exact time/i);
  expect(result.chips.map((c) => c.value)).toEqual(EXPECTED_CHIPS);
}

describe("calendar compliance — bot never quotes a time/window to the customer", () => {
  it("wide-open calendar → soft preference only, no date or openings", () => {
    const techs = ["t1", "t2"];
    const availability = [fullDaySlot("t1", 3), fullDaySlot("t2", 3)];
    expectSoftPreference(offerFor(techs, availability, [], [WED]));
  });

  it("partially booked calendar → SAME soft preference, leaks no capacity", () => {
    const techs = ["t1", "t2"];
    const availability = [fullDaySlot("t1", 3), fullDaySlot("t2", 3)];
    // Both techs booked the morning band — capacity differs, prompt must not.
    const jobs = [bookedJob("t1", WED, 8, 12), bookedJob("t2", WED, 8, 12)];
    expectSoftPreference(offerFor(techs, availability, jobs, [WED]));
  });

  it("fully booked calendar → SAME soft preference (never reveals 'fully booked')", () => {
    const techs = ["t1"];
    const availability = [fullDaySlot("t1", 3)];
    const jobs = [bookedJob("t1", WED, 8, 20)]; // all of Wed booked
    expectSoftPreference(offerFor(techs, availability, jobs, [WED]));
  });

  it("no availability configured → SAME soft preference", () => {
    expectSoftPreference(offerFor(["t1"], [], [], [WED]));
  });

  it("multi-day mixed bookings → prompt is identical regardless", () => {
    const techs = ["t1", "t2"];
    const availability = [
      fullDaySlot("t1", 3),
      fullDaySlot("t2", 3),
      fullDaySlot("t1", 4),
      fullDaySlot("t2", 4),
    ];
    const jobs = [
      bookedJob("t1", WED, 8, 12),
      bookedJob("t2", WED, 8, 12),
      bookedJob("t1", WED, 12, 16),
    ];
    expectSoftPreference(offerFor(techs, availability, jobs, [WED, THU]));
  });
});
