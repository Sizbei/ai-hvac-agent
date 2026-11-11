import { describe, expect, it } from "vitest";
import {
  EMPTY_LANE_COPY,
  unscheduledLinkAriaLabel,
  unscheduledLinkLabel,
  UNASSIGNED_EMPTY_COPY,
} from "./dispatch-empty";

describe("dispatch board empty copy", () => {
  it("uses request, not job", () => {
    expect(UNASSIGNED_EMPTY_COPY).toBe("Nothing unassigned");
    expect(EMPTY_LANE_COPY).toBe("No requests");
  });
  it("links unscheduled requests to the calendar only when there are some", () => {
    expect(unscheduledLinkLabel(0)).toBeNull();
    expect(unscheduledLinkLabel(18)).toBe("18 unscheduled → Calendar");
  });
  it("names the calendar link without the arrow for screen readers", () => {
    expect(unscheduledLinkAriaLabel(18)).toBe("18 unscheduled requests. Open the calendar");
    expect(unscheduledLinkAriaLabel(1)).toBe("1 unscheduled request. Open the calendar");
    expect(unscheduledLinkAriaLabel(18)).not.toContain("→");
  });
});
