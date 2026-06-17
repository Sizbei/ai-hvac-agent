/**
 * Calendar-compliance integration test — "the bot offers options, never commits."
 *
 * Policy (CHATBOT-PLAN Step 11+6): the customer-facing window offer
 * (buildWindowPrompt) surfaces REAL open day/time-band options as a PREFERENCE
 * capture — but it must NEVER commit to a time: no "booked"/"scheduled"/
 * "confirmed"/"you're all set" language, and no $ price. The team coordinates the
 * actual time later and the customer/staff still finalize. When the calendar has
 * no openings (fully booked / nothing configured) the offer falls back to the
 * generic soft time-of-day preference.
 *
 * This test wires the real pure capacity layer (computeOpenWindows) into the
 * prompt builder exactly as the live path does, and proves the offer reflects the
 * calendar (open bands appear, fully-booked bands don't) WITHOUT ever committing.
 *
 * (computeOpenWindows' capacity math is covered by availability.test.ts; here we
 * assert the customer prompt's offer-not-commit contract end to end.)
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

// Chip VALUES must always stay on the existing band enum so capture stays
// deterministic, regardless of whether concrete bands or the fallback is shown.
const ALLOWED_CHIP_VALUES = new Set(["morning", "afternoon", "evening", "asap"]);

// Commitment language the offer must NEVER use — the offer-not-commit guardrail.
const COMMITMENT_REGEX =
  /\b(booked|scheduled|confirmed|you'?re all set|reserved)\b/i;
const PRICE_REGEX = /\$\s?\d/;

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

/** Assert any offer (concrete OR fallback) honors the offer-not-commit contract:
 * no commitment language, no price, and chip values on the band enum. */
function expectNeverCommits(result: ReturnType<typeof buildWindowPrompt>) {
  expect(result.question).not.toMatch(COMMITMENT_REGEX);
  expect(result.question).not.toMatch(PRICE_REGEX);
  expect(result.chips.every((c) => ALLOWED_CHIP_VALUES.has(c.value))).toBe(true);
}

/** Assert the generic soft-preference fallback (used when nothing is open). */
function expectSoftPreferenceFallback(
  result: ReturnType<typeof buildWindowPrompt>,
) {
  expect(result.question).toMatch(/preference on time of day/i);
  expect(result.question).toMatch(/team coordinates the actual time/i);
  expect(result.chips.map((c) => c.value)).toEqual([
    "morning",
    "afternoon",
    "evening",
    "asap",
  ]);
  expectNeverCommits(result);
}

describe("calendar compliance — bot offers options but never commits to a time", () => {
  it("wide-open calendar → offers concrete bands, never commits", () => {
    const techs = ["t1", "t2"];
    const availability = [fullDaySlot("t1", 3), fullDaySlot("t2", 3)];
    const offer = offerFor(techs, availability, [], [WED]);
    // A real opening is surfaced as a preference ask…
    expect(offer.question).toMatch(/preferred time/i);
    expect(offer.question).toMatch(/Wed (morning|afternoon|evening)/);
    // …but never as a commitment.
    expectNeverCommits(offer);
  });

  it("partially booked calendar → only OPEN bands offered, never commits", () => {
    const techs = ["t1", "t2"];
    const availability = [fullDaySlot("t1", 3), fullDaySlot("t2", 3)];
    // Both techs booked the morning band → morning is fully booked on Wed.
    const jobs = [bookedJob("t1", WED, 8, 12), bookedJob("t2", WED, 8, 12)];
    const offer = offerFor(techs, availability, jobs, [WED]);
    // Afternoon/evening are still open; Wed morning is gone.
    expect(offer.question).not.toContain("Wed morning");
    expect(offer.question).toMatch(/Wed (afternoon|evening)/);
    expectNeverCommits(offer);
  });

  it("fully booked calendar → soft-preference fallback (never reveals 'fully booked')", () => {
    const techs = ["t1"];
    const availability = [fullDaySlot("t1", 3)];
    const jobs = [bookedJob("t1", WED, 8, 20)]; // all of Wed booked
    const offer = offerFor(techs, availability, jobs, [WED]);
    // No openings → generic ask, and it must not announce the calendar is full.
    expectSoftPreferenceFallback(offer);
    expect(offer.question).not.toMatch(/fully booked|no openings|nothing open/i);
  });

  it("no availability configured → soft-preference fallback", () => {
    expectSoftPreferenceFallback(offerFor(["t1"], [], [], [WED]));
  });

  it("multi-day mixed bookings → offers soonest open bands, never commits", () => {
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
    const offer = offerFor(techs, availability, jobs, [WED, THU]);
    // Wed morning fully booked → not offered; later open bands are.
    expect(offer.question).not.toContain("Wed morning");
    expect(offer.question).toMatch(/(Wed|Thu) (afternoon|evening|morning)/);
    expectNeverCommits(offer);
  });
});
