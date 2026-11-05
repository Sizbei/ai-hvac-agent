import { describe, expect, it } from "vitest";
import { HOUR_OPTIONS, hourLabel, timezoneOptions } from "./after-hours-options";

describe("hourLabel", () => {
  it("labels the 24 hours in 12-hour form", () => {
    expect(hourLabel(0)).toBe("12 am (midnight)");
    expect(hourLabel(8)).toBe("8 am");
    expect(hourLabel(12)).toBe("12 pm (noon)");
    expect(hourLabel(18)).toBe("6 pm");
    expect(HOUR_OPTIONS).toHaveLength(24);
    expect(HOUR_OPTIONS[23]).toEqual({ value: "23", label: "11 pm" });
  });
});

describe("timezoneOptions", () => {
  it("lists US zones and keeps a stored zone that isn't in the list", () => {
    expect(timezoneOptions("America/Chicago").some((o) => o.value === "America/Chicago")).toBe(true);
    const withEurope = timezoneOptions("Europe/London");
    expect(withEurope.at(-1)).toEqual({ value: "Europe/London", label: "Europe/London" });
    expect(timezoneOptions("America/New_York")).toHaveLength(7);
  });
});
