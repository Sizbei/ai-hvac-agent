import { describe, it, expect } from "vitest";
import { issueLabel, overdueLabel, statusLabel, visitBadge, visitWhen, visitWindow } from "./job-display";

const NOW = new Date("2026-11-05T15:00:00Z"); // Thu Nov 5, 10:00 AM Eastern
const TZ = "America/New_York";

describe("issueLabel", () => {
  it("humanizes snake case", () => {
    expect(issueLabel("cooling_not_working")).toBe("Cooling not working");
    expect(issueLabel("thermostat_issue")).toBe("Thermostat issue");
    expect(issueLabel("maintenance")).toBe("Maintenance");
  });
  it("maps known codes to nicer words", () => {
    expect(issueLabel("air_quality")).toBe("Indoor air quality");
    expect(issueLabel("other")).toBe("Other issue");
  });
  it("falls back when empty", () => {
    expect(issueLabel("")).toBe("Service request");
    expect(issueLabel(null)).toBe("Service request");
  });
  it("shows an imported job title as typed", () => {
    expect(issueLabel("Change out ODU & Coil")).toBe("Change out ODU & Coil");
    expect(issueLabel("HVAC in back room  not working")).toBe("HVAC in back room not working");
    expect(issueLabel("constructor")).toBe("Constructor");
  });
});

describe("statusLabel", () => {
  it("sentence case", () => expect(statusLabel("in_progress")).toBe("In progress"));
});

describe("visitWhen", () => {
  it("weekday, month day · time, no year this year", () => {
    expect(visitWhen("2026-08-14T02:41:48Z", NOW, TZ)).toBe("Thu, Aug 13 · 10:41 PM");
  });
  it("shows the year when it isn't this year", () => {
    expect(visitWhen("2025-12-30T14:00:00Z", NOW, TZ)).toBe("Tue, Dec 30, 2025 · 9:00 AM");
  });
  it("null for missing or bad input", () => {
    expect(visitWhen(null, NOW, TZ)).toBeNull();
    expect(visitWhen("nope", NOW, TZ)).toBeNull();
  });
});

describe("visitWindow", () => {
  it("same-day window", () => {
    expect(visitWindow("2026-11-05T13:00:00Z", "2026-11-05T17:00:00Z", NOW, TZ)).toBe("Thu, Nov 5 · 8:00 AM – 12:00 PM");
  });
  it("a window past midnight names the end day", () => {
    expect(visitWindow("2026-08-14T02:41:00Z", "2026-08-14T04:41:00Z", NOW, TZ)).toBe("Thu, Aug 13 · 10:41 PM – Fri 12:41 AM");
  });
  it("start only", () => {
    expect(visitWindow("2026-11-05T13:00:00Z", null, NOW, TZ)).toBe("Thu, Nov 5 · 8:00 AM");
  });
  it("null without a start", () => expect(visitWindow(null, "2026-11-05T13:00:00Z", NOW, TZ)).toBeNull());
});

describe("overdueLabel", () => {
  const AUG13 = "2026-08-14T02:41:48Z"; // Aug 13 Eastern
  it("an open row on an earlier day is overdue", () => {
    expect(overdueLabel(AUG13, "scheduled", "scheduled", NOW, TZ)).toBe("Overdue · Aug 13");
    expect(overdueLabel(AUG13, "en_route", "en_route", NOW, TZ)).toBe("Overdue · Aug 13");
  });
  it("today and later are not overdue", () => {
    expect(overdueLabel("2026-11-05T23:00:00Z", "scheduled", "scheduled", NOW, TZ)).toBeNull();
    expect(overdueLabel("2026-11-09T15:00:00Z", "scheduled", "scheduled", NOW, TZ)).toBeNull();
  });
  it("a finished or held row is not overdue", () => {
    expect(overdueLabel(AUG13, "completed", "completed", NOW, TZ)).toBeNull();
    expect(overdueLabel(AUG13, "cancelled", "scheduled", NOW, TZ)).toBeNull();
    expect(overdueLabel(AUG13, "completed", "on_hold", NOW, TZ)).toBeNull();
  });
  it("adds the year for an older year", () => {
    expect(overdueLabel("2025-12-30T14:00:00Z", "scheduled", "scheduled", NOW, TZ)).toBe("Overdue · Dec 30, 2025");
  });
  it("null without a date", () => expect(overdueLabel(null, "scheduled", "scheduled", NOW, TZ)).toBeNull());
});

describe("visitBadge", () => {
  it("held request reads On hold, not Completed", () => {
    expect(visitBadge("completed", "on_hold")).toBe("On hold");
  });
  it("otherwise the visit status in sentence case", () => {
    expect(visitBadge("in_progress", "in_progress")).toBe("In progress");
    expect(visitBadge("completed", "completed")).toBe("Completed");
    expect(visitBadge("cancelled", "on_hold")).toBe("Cancelled");
  });
});
