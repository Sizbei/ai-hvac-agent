import { describe, it, expect } from "vitest";
import { formatMinutes, groupEntriesByDay, entryLabel, type TimesheetEntry } from "./timesheets-grouping";

function e(over: Partial<TimesheetEntry>): TimesheetEntry {
  return {
    id: "x", kind: "job", clockInAt: "2026-11-03T15:00:00.000Z", clockOutAt: "2026-11-03T16:00:00.000Z",
    minutes: 60, laborCostCents: 5000, referenceNumber: "REQ-1", appointmentNumber: 1, clockInMethod: "auto",
    ...over,
  };
}

describe("formatMinutes", () => {
  it("formats h:mm", () => {
    expect(formatMinutes(0)).toBe("0:00");
    expect(formatMinutes(75)).toBe("1:15");
    expect(formatMinutes(605)).toBe("10:05");
  });
});

describe("entryLabel", () => {
  it("General for general rows, ref with visit otherwise", () => {
    expect(entryLabel(e({ kind: "general", referenceNumber: null, appointmentNumber: null }))).toBe("General");
    expect(entryLabel(e({}))).toBe("REQ-1");
    expect(entryLabel(e({ appointmentNumber: 2 }))).toBe("REQ-1 · Visit 2");
  });
});

describe("groupEntriesByDay", () => {
  it("groups by Eastern day (not UTC), newest first, with totals; open rows add no minutes", () => {
    // 2026-11-04T02:00Z is still Nov 3 evening Eastern (EST, UTC-5).
    const groups = groupEntriesByDay([
      e({ id: "a", clockInAt: "2026-11-04T02:00:00.000Z", minutes: 30, laborCostCents: 1000 }),
      e({ id: "b", clockInAt: "2026-11-03T15:00:00.000Z", minutes: 90, laborCostCents: 2000 }),
      e({ id: "c", clockInAt: "2026-11-02T15:00:00.000Z", minutes: null, laborCostCents: null, clockOutAt: null }),
    ]);
    expect(groups.map((g) => g.date)).toEqual(["2026-11-03", "2026-11-02"]);
    expect(groups[0]).toMatchObject({ totalMinutes: 120, totalCostCents: 3000 });
    expect(groups[0].entries.map((x) => x.id)).toEqual(["a", "b"]);
    expect(groups[1]).toMatchObject({ totalMinutes: 0, totalCostCents: 0 });
  });
});
