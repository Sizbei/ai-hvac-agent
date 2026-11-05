import { describe, it, expect } from "vitest";
import { describeDragJob, describeDropTarget } from "./calendar-dnd";

const names = new Map([["tech-1", "Odessa Dagley"]]);

describe("drag announcements use words, not ids", () => {
  it("describes a technician's window band", () => {
    expect(
      describeDropTarget({ kind: "window", scope: "tech-1", isoDay: "2026-11-05", window: "afternoon" }, names),
    ).toBe("the afternoon window on Thursday, November 5 for Odessa Dagley");
  });
  it("describes an unassigned band and the queue", () => {
    expect(
      describeDropTarget({ kind: "window", scope: "unassigned", isoDay: "2026-11-05", window: "morning" }, names),
    ).toBe("the morning window on Thursday, November 5");
    expect(describeDropTarget({ kind: "unscheduled" }, names)).toBe("the Unscheduled list");
  });
  it("never leaks an unknown technician id", () => {
    const text = describeDropTarget({ kind: "window", scope: "c5c5fa34-uuid", isoDay: "2026-11-05", window: "evening" }, names);
    expect(text).not.toContain("c5c5fa34");
    expect(text).toContain("a technician");
  });
  it("names the job by its label", () => {
    expect(describeDragJob({ label: "Boone Dental, HVAC-1" })).toBe("Boone Dental, HVAC-1");
    expect(describeDragJob(undefined)).toBe("The request");
  });
});
