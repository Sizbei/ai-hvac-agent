import { describe, it, expect } from "vitest";
import { computeOpenWindows } from "./availability";
import { businessWallClockToUtc } from "./calendar-time";
import type { AvailabilitySlot, ScheduledJob } from "./types";

// 2026-07-01 is a Wednesday (weekday 3), summer → EDT (UTC-4).
const WED = "2026-07-01";
// 2026-01-07 is a Wednesday (weekday 3), winter → EST (UTC-5).
const WED_WINTER = "2026-01-07";

function slot(
  technicianId: string,
  overrides: Partial<AvailabilitySlot> = {},
): AvailabilitySlot {
  return {
    id: `av-${technicianId}`,
    technicianId,
    dayOfWeek: 3, // Wednesday
    startMinute: 8 * 60,
    endMinute: 20 * 60, // full 8am–8pm so every band is covered by default
    ...overrides,
  };
}

/** A booked job occupying a band on a business day, expressed in Eastern
 * wall-clock via businessWallClockToUtc so the booked instants line up with how
 * the day renders (DST-correct). */
function job(
  technicianId: string | null,
  isoDay: string,
  startHour: number,
  endHour: number,
  overrides: Partial<ScheduledJob> = {},
): ScheduledJob {
  return {
    id: `job-${technicianId}-${startHour}`,
    referenceNumber: "HVAC-TEST",
    status: "scheduled",
    assignedTo: technicianId,
    arrivalWindowStart: businessWallClockToUtc(isoDay, startHour, 0).toISOString(),
    arrivalWindowEnd: businessWallClockToUtc(isoDay, endHour, 0).toISOString(),
    ...overrides,
  };
}

describe("computeOpenWindows — capacity", () => {
  it("counts every active tech whose hours cover a band", () => {
    const techs = ["t1", "t2"];
    const avail = [slot("t1"), slot("t2")];
    const out = computeOpenWindows(techs, avail, [], [WED]);
    // 3 bands, both techs cover all → capacity 2, available 2 each.
    expect(out).toHaveLength(3);
    for (const w of out) {
      expect(w.capacity).toBe(2);
      expect(w.available).toBe(2);
    }
  });

  it("omits a band no tech works (not a 0-available slot)", () => {
    // A tech working only mornings (8–12): afternoon/evening have no capacity.
    const out = computeOpenWindows(
      ["t1"],
      [slot("t1", { startMinute: 8 * 60, endMinute: 12 * 60 })],
      [],
      [WED],
    );
    expect(out.map((w) => w.window)).toEqual(["morning"]);
    expect(out[0]!.capacity).toBe(1);
  });

  it("ignores availability for techs not in the active set", () => {
    // t2 has hours but isn't active → only t1 counts.
    const out = computeOpenWindows(
      ["t1"],
      [slot("t1"), slot("t2")],
      [],
      [WED],
    );
    expect(out.every((w) => w.capacity === 1)).toBe(true);
  });

  it("treats no availability as no bands (out-of-hours, not blanket-open)", () => {
    expect(computeOpenWindows(["t1"], [], [], [WED])).toEqual([]);
  });
});

describe("computeOpenWindows — availability MINUS bookings", () => {
  it("subtracts a tech booked into a band", () => {
    const techs = ["t1", "t2"];
    const avail = [slot("t1"), slot("t2")];
    // t1 booked 8–12 (morning) on WED.
    const jobs = [job("t1", WED, 8, 12)];
    const out = computeOpenWindows(techs, avail, jobs, [WED]);
    const morning = out.find((w) => w.window === "morning")!;
    expect(morning.capacity).toBe(2);
    expect(morning.available).toBe(1); // t2 still free
    // Other bands untouched.
    expect(out.find((w) => w.window === "afternoon")!.available).toBe(2);
  });

  it("a wide (all-day) job occupies all three bands for that tech", () => {
    const out = computeOpenWindows(
      ["t1", "t2"],
      [slot("t1"), slot("t2")],
      [job("t1", WED, 8, 20)], // anytime span
      [WED],
    );
    for (const w of out) {
      expect(w.available).toBe(1); // t1 booked everywhere, t2 free everywhere
    }
  });

  it("a back-to-back job ending exactly at the band start does NOT book the band", () => {
    // Job 8–12 (morning) ends exactly at the afternoon start (12) → afternoon free.
    const out = computeOpenWindows(
      ["t1"],
      [slot("t1")],
      [job("t1", WED, 8, 12)],
      [WED],
    );
    expect(out.find((w) => w.window === "afternoon")!.available).toBe(1);
    expect(out.find((w) => w.window === "morning")!.available).toBe(0);
  });

  it("floors available at 0 and never goes negative", () => {
    // One tech, booked morning → available 0 (not -…).
    const out = computeOpenWindows(
      ["t1"],
      [slot("t1")],
      [job("t1", WED, 8, 12)],
      [WED],
    );
    expect(out.find((w) => w.window === "morning")!.available).toBe(0);
  });

  it("ignores a job on a DIFFERENT business day", () => {
    // Job is on a different Wednesday; the day under test sees full capacity.
    const out = computeOpenWindows(
      ["t1"],
      [slot("t1")],
      [job("t1", "2026-07-08", 8, 12)],
      [WED],
    );
    expect(out.find((w) => w.window === "morning")!.available).toBe(1);
  });

  it("ignores an unassigned job (no tech to subtract)", () => {
    const out = computeOpenWindows(
      ["t1"],
      [slot("t1")],
      [job(null, WED, 8, 12)],
      [WED],
    );
    expect(out.find((w) => w.window === "morning")!.available).toBe(1);
  });

  it("does not subtract a tech whose hours don't cover the booked band", () => {
    // t1 works only mornings but somehow has an afternoon job (data drift):
    // afternoon has no capacity, so the job can't push it negative or appear.
    const out = computeOpenWindows(
      ["t1"],
      [slot("t1", { startMinute: 8 * 60, endMinute: 12 * 60 })],
      [job("t1", WED, 12, 16)],
      [WED],
    );
    expect(out.map((w) => w.window)).toEqual(["morning"]);
    expect(out[0]!.available).toBe(1);
  });
});

describe("computeOpenWindows — DST safety", () => {
  it("computes the same band structure in winter (EST) as summer (EDT)", () => {
    // Same weekday (Wed), opposite DST sides; full-day hours → 3 bands each.
    const summer = computeOpenWindows(["t1"], [slot("t1")], [], [WED]);
    const winter = computeOpenWindows(["t1"], [slot("t1")], [], [WED_WINTER]);
    expect(summer.map((w) => w.window)).toEqual(winter.map((w) => w.window));
    expect(summer.every((w) => w.capacity === 1)).toBe(true);
    expect(winter.every((w) => w.capacity === 1)).toBe(true);
  });

  it("subtracts a winter (EST) booking correctly via business wall-clock", () => {
    // Booked 8–12 EST → morning is booked on the winter Wednesday.
    const out = computeOpenWindows(
      ["t1"],
      [slot("t1")],
      [job("t1", WED_WINTER, 8, 12)],
      [WED_WINTER],
    );
    expect(out.find((w) => w.window === "morning")!.available).toBe(0);
    expect(out.find((w) => w.window === "afternoon")!.available).toBe(1);
  });
});

describe("computeOpenWindows — PII-free output", () => {
  it("returns only counts — no technician name or id leaks", () => {
    const out = computeOpenWindows(
      ["tech-secret-id"],
      [slot("tech-secret-id")],
      [job("tech-secret-id", WED, 8, 12)],
      [WED],
    );
    for (const w of out) {
      expect(Object.keys(w).sort()).toEqual(
        ["available", "capacity", "day", "window"].sort(),
      );
      // No field carries the tech id.
      expect(JSON.stringify(w)).not.toContain("tech-secret-id");
    }
  });
});

describe("computeOpenWindows — multi-day ordering", () => {
  it("returns bands day-then-window across multiple days", () => {
    const days = [WED, "2026-07-02"]; // Wed, Thu
    const avail = [slot("t1"), slot("t1", { dayOfWeek: 4 })]; // Wed + Thu hours
    const out = computeOpenWindows(["t1"], avail, [], days);
    // First three entries are WED, next three are Thu.
    expect(out.slice(0, 3).every((w) => w.day === WED)).toBe(true);
    expect(out.slice(3).every((w) => w.day === "2026-07-02")).toBe(true);
  });
});
