import { describe, it, expect } from "vitest";
import {
  afterHoursConfigSchema,
  DEFAULT_AFTER_HOURS_CONFIG,
  isAfterHours,
  resolveAfterHoursConfig,
  type AfterHoursConfig,
} from "./after-hours";

// All time math is done in the org's configured IANA timezone. Tests pass a
// fixed instant + an explicit tz so they're deterministic (no Date.now()).
const cfg: AfterHoursConfig = {
  enabled: true,
  startHour: 18, // 6pm
  endHour: 8, // 8am
  weekendsAreAfterHours: true,
  timezone: "America/Chicago",
};

describe("isAfterHours", () => {
  it("is true after the start hour on a weekday", () => {
    // 2026-06-10 is a Wednesday. 7pm Chicago = 00:00Z next day.
    const at = new Date("2026-06-11T00:00:00Z"); // 7pm Wed in Chicago (CDT, UTC-5)
    expect(isAfterHours(at, cfg)).toBe(true);
  });

  it("is false midday on a weekday", () => {
    const at = new Date("2026-06-10T17:00:00Z"); // 12pm Wed Chicago
    expect(isAfterHours(at, cfg)).toBe(false);
  });

  it("is true early morning before the end hour", () => {
    const at = new Date("2026-06-10T10:00:00Z"); // 5am Wed Chicago
    expect(isAfterHours(at, cfg)).toBe(true);
  });

  it("is true all day on a weekend when weekendsAreAfterHours", () => {
    const sat = new Date("2026-06-13T17:00:00Z"); // 12pm Saturday Chicago
    expect(isAfterHours(sat, cfg)).toBe(true);
  });

  it("is false on a weekend midday when weekend flag is off", () => {
    const sat = new Date("2026-06-13T17:00:00Z");
    expect(isAfterHours(sat, { ...cfg, weekendsAreAfterHours: false })).toBe(false);
  });

  it("is always false when after-hours is disabled", () => {
    const at = new Date("2026-06-11T03:00:00Z"); // 10pm Wed Chicago
    expect(isAfterHours(at, { ...cfg, enabled: false })).toBe(false);
  });
});

describe("afterHoursConfigSchema", () => {
  it("accepts a valid config", () => {
    expect(afterHoursConfigSchema.parse(cfg)).toEqual(cfg);
  });

  it("rejects an out-of-range hour", () => {
    expect(afterHoursConfigSchema.safeParse({ ...cfg, startHour: 25 }).success).toBe(false);
  });

  it("rejects unknown keys like a stale flat fee (strict schema)", () => {
    expect(
      afterHoursConfigSchema.safeParse({ ...cfg, flatFee: 150 }).success,
    ).toBe(false);
  });

  it("rejects an invalid timezone", () => {
    expect(afterHoursConfigSchema.safeParse({ ...cfg, timezone: "Mars/Olympus" }).success).toBe(false);
  });
});

describe("resolveAfterHoursConfig", () => {
  it("returns the default when the stored value is null/absent", () => {
    expect(resolveAfterHoursConfig(null)).toEqual(DEFAULT_AFTER_HOURS_CONFIG);
    expect(resolveAfterHoursConfig(undefined)).toEqual(DEFAULT_AFTER_HOURS_CONFIG);
  });

  it("returns the stored config when valid", () => {
    expect(resolveAfterHoursConfig(cfg)).toEqual(cfg);
  });

  it("falls back to default on a malformed stored value", () => {
    expect(resolveAfterHoursConfig({ startHour: 99 })).toEqual(DEFAULT_AFTER_HOURS_CONFIG);
  });
});
