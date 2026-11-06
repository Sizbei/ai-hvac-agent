import { describe, it, expect } from "vitest";
import { dateInZone, zonedDayRange, zonedMidnight } from "./zoned-date";

const NY = "America/New_York";

describe("dateInZone", () => {
  it("an 8 pm Eastern payment on Nov 5 is a Nov 5 payment, not Nov 6 (UTC)", () => {
    const instant = new Date("2026-11-06T01:00:00.000Z"); // 8 pm EST Nov 5
    expect(dateInZone(instant, NY)).toBe("2026-11-05");
    expect(dateInZone(instant, "UTC")).toBe("2026-11-06");
  });
  it("month-end evening work stays in its month", () => {
    expect(dateInZone(new Date("2026-11-01T03:30:00.000Z"), NY)).toBe("2026-10-31");
  });
  it("other zones", () => {
    expect(dateInZone(new Date("2026-07-01T05:30:00.000Z"), "America/Chicago")).toBe("2026-07-01");
    expect(dateInZone(new Date("2026-07-01T04:30:00.000Z"), "America/Chicago")).toBe("2026-06-30");
  });
});

describe("zonedMidnight / zonedDayRange", () => {
  it("midnight Eastern in winter and summer (DST)", () => {
    expect(zonedMidnight("2026-01-15", NY).toISOString()).toBe("2026-01-15T05:00:00.000Z");
    expect(zonedMidnight("2026-07-15", NY).toISOString()).toBe("2026-07-15T04:00:00.000Z");
  });
  it("on the DST change days", () => {
    expect(zonedMidnight("2026-03-08", NY).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(zonedMidnight("2026-11-01", NY).toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
  it("covers whole business days, inclusive of the last", () => {
    const r = zonedDayRange("2026-11-01", "2026-11-05", NY);
    expect(r.fromDate.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(r.toDate.toISOString()).toBe("2026-11-06T04:59:59.999Z");
  });
});
