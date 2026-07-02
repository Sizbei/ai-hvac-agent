import { describe, it, expect } from "vitest";
import { baseDurationMinutes } from "./duration";

const job = (over: Partial<Parameters<typeof baseDurationMinutes>[0]> = {}) => ({
  jobType: null,
  systemType: null,
  equipmentAgeBand: null,
  ...over,
});

describe("baseDurationMinutes", () => {
  it("uses the per-type base (rounded to 15)", () => {
    expect(baseDurationMinutes(job({ jobType: "install" }))).toBe(480);
    expect(baseDurationMinutes(job({ jobType: "estimate" }))).toBe(30);
  });

  it("falls back to 90 for a null/unknown job type", () => {
    expect(baseDurationMinutes(job())).toBe(90);
    expect(baseDurationMinutes(job({ jobType: "totally_unknown" }))).toBe(90);
  });

  it("applies system + age modifiers and clamps/rounds", () => {
    // 90 * 1.2 = 108 → round-15 → 105
    expect(baseDurationMinutes(job({ jobType: "repair", systemType: "heat_pump" }))).toBe(105);
    // 90 * 1.5 = 135 (over_15) → 135
    expect(baseDurationMinutes(job({ jobType: "repair", equipmentAgeBand: "over_15" }))).toBe(135);
  });

  it("never exceeds the 480-minute ceiling", () => {
    // install 480 * 1.4 (boiler) * 1.5 (over_15) would be 1008 → clamped to 480
    expect(
      baseDurationMinutes(
        job({ jobType: "install", systemType: "boiler", equipmentAgeBand: "over_15" }),
      ),
    ).toBe(480);
  });
});
