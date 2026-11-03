import { describe, it, expect } from "vitest";
import { classifyVisit, type VisitRow } from "./visit-range";

const TODAY = "2026-11-03";
const row = (over: Partial<VisitRow>): VisitRow => ({
  assignmentStatus: "scheduled",
  requestStatus: "scheduled",
  scheduledDay: TODAY,
  completedDay: null,
  ...over,
});

describe("classifyVisit", () => {
  it("open row dated today is today", () => {
    expect(classifyVisit(row({}), TODAY)).toBe("today");
  });
  it("overdue open row stays in today", () => {
    expect(classifyVisit(row({ scheduledDay: "2026-10-20" }), TODAY)).toBe("today");
  });
  it("undated open row is today", () => {
    expect(classifyVisit(row({ scheduledDay: null }), TODAY)).toBe("today");
  });
  it("future open row is upcoming", () => {
    expect(classifyVisit(row({ scheduledDay: "2026-11-10" }), TODAY)).toBe("upcoming");
  });
  it("open row on a completed or cancelled request is hidden", () => {
    expect(classifyVisit(row({ requestStatus: "completed" }), TODAY)).toBe("hidden");
    expect(classifyVisit(row({ requestStatus: "cancelled", scheduledDay: "2026-11-10" }), TODAY)).toBe("hidden");
  });
  it("terminal row completed yesterday is past", () => {
    expect(classifyVisit(row({ assignmentStatus: "completed", completedDay: "2026-11-02" }), TODAY)).toBe("past");
  });
  it("completed today is past, not today", () => {
    expect(classifyVisit(row({ assignmentStatus: "completed", completedDay: TODAY }), TODAY)).toBe("past");
  });
  it("terminal row on the 30-day boundary is past, one day older is hidden", () => {
    expect(classifyVisit(row({ assignmentStatus: "completed", completedDay: "2026-10-04" }), TODAY)).toBe("past");
    expect(classifyVisit(row({ assignmentStatus: "completed", completedDay: "2026-10-03" }), TODAY)).toBe("hidden");
  });
  it("terminal row without completedAt falls back to the scheduled day", () => {
    expect(classifyVisit(row({ assignmentStatus: "completed", scheduledDay: "2026-10-20" }), TODAY)).toBe("past");
    expect(classifyVisit(row({ assignmentStatus: "completed", scheduledDay: "2026-08-01" }), TODAY)).toBe("hidden");
  });
  it("cancelled row with progress is past even when its request is still open", () => {
    expect(classifyVisit(row({ assignmentStatus: "cancelled", completedDay: null, scheduledDay: "2026-11-01" }), TODAY)).toBe("past");
  });
});
