import { describe, it, expect } from "vitest";
import { missingLine, REOPEN_ANSWERS_REMOVED, REOPEN_STALE, reopenDescription, submissionChip, visitLabel, whoWhen } from "./request-forms-view";

describe("office Forms section copy (spec §7.5)", () => {
  it("visit label: ended or nothing", () => {
    expect(visitLabel({ appointmentNumber: 1, visitState: "live" })).toBe("Visit #1");
    expect(visitLabel({ appointmentNumber: 2, visitState: "ended" })).toBe("Visit #2 · ended");
  });
  it("chips", () => {
    expect(submissionChip({ erased: true, unreadable: false, status: "submitted" })).toBe("Answers removed");
    expect(submissionChip({ erased: false, unreadable: true, status: "draft" })).toBe("These answers can't be shown.");
    expect(submissionChip({ erased: false, unreadable: false, status: "submitted" })).toBe("Submitted");
    expect(submissionChip({ erased: false, unreadable: false, status: "draft" })).toBe("Draft");
  });
  it("who and when", () => {
    const at = "2026-11-07T19:41:00.000Z";
    expect(whoWhen({ status: "submitted", submittedAt: at, submittedByName: "Alex Rivera", updatedAt: at, updatedByName: null }, "America/New_York")).toBe("Submitted by Alex Rivera · Nov 7, 2:41 PM");
    expect(whoWhen({ status: "draft", submittedAt: null, submittedByName: null, updatedAt: at, updatedByName: "Sam Lee" }, "America/New_York")).toBe("Last saved by Sam Lee · Nov 7, 2:41 PM");
  });
  it("missing lines and the reopen confirm", () => {
    expect(missingLine("Maintenance checklist", "in_progress")).toEqual({ text: "Not submitted yet: Maintenance checklist", warning: false });
    expect(missingLine("Maintenance checklist", "completed")).toEqual({ text: "Required, not submitted: Maintenance checklist", warning: true });
    expect(reopenDescription(true)).toBe("The technician can change the answers and submit again.");
    expect(reopenDescription(false)).toBe("The technician can change the answers and submit again. No technician is on this visit any more.");
  });
  it("reopen refusals reuse the route copy", () => {
    expect(REOPEN_STALE).toBe("Someone else changed this form. Reload to see the latest.");
    expect(REOPEN_ANSWERS_REMOVED).toBe("These answers were removed.");
  });
});
