import { describe, expect, it } from "vitest";
import { EMPTY_LANE_COPY, unscheduledLinkLabel, UNASSIGNED_EMPTY_COPY } from "./dispatch-empty";

describe("dispatch board empty copy", () => {
  it("uses request, not job", () => {
    expect(UNASSIGNED_EMPTY_COPY).toBe("No requests scheduled today");
    expect(EMPTY_LANE_COPY).toBe("No requests");
  });
  it("links unscheduled requests to the calendar only when there are some", () => {
    expect(unscheduledLinkLabel(0)).toBeNull();
    expect(unscheduledLinkLabel(18)).toBe("18 unscheduled → Calendar");
  });
});
