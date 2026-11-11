import { describe, expect, it } from "vitest";
import { fieldpulseMetricRows, requestFieldpulseExtras } from "./request-fieldpulse-view";

const metrics = (totalPriceCents: number | null, onTheWay: number | null = null, inProgress: number | null = null) => ({
  statusLogSeconds: { on_the_way: onTheWay, in_progress: inProgress },
  totalPriceCents,
});

describe("fieldpulseMetricRows", () => {
  it("hides a $0 total and empty times", () => {
    expect(fieldpulseMetricRows(metrics(0, 0, null))).toEqual([]);
    expect(fieldpulseMetricRows(null)).toEqual([]);
  });
  it("shows a real total and times", () => {
    const rows = fieldpulseMetricRows(metrics(122757, 900, 5400));
    expect(rows.map((r) => r.label)).toEqual(["Total price", "Time on the way", "Time in progress"]);
    expect(rows[0].value).toBe("$1,227.57");
  });
});

describe("requestFieldpulseExtras", () => {
  it("drops bare tag ids and a false multi-day flag", () => {
    expect(requestFieldpulseExtras({ tags: "498516, 498095", is_multiday_job: false })).toEqual({
      details: null,
      multiDay: false,
    });
  });
  it("turns a true multi-day flag into a badge and keeps other fields", () => {
    expect(requestFieldpulseExtras({ is_multiday_job: true, due_date: "2026-07-01" })).toEqual({
      details: { due_date: "2026-07-01" },
      multiDay: true,
    });
  });
  it("handles null", () => {
    expect(requestFieldpulseExtras(null)).toEqual({ details: null, multiDay: false });
  });
});
