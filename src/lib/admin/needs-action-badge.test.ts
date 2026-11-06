import { describe, it, expect } from "vitest";
import { needsActionBadge } from "./needs-action-badge";
import { UNSCHEDULED_BADGE_CAP } from "./unscheduled-badge";

describe("needsActionBadge", () => {
  it("hides at zero and for bad input", () => {
    expect(needsActionBadge(0).visible).toBe(false);
    expect(needsActionBadge(-3).visible).toBe(false);
    expect(needsActionBadge(Number.NaN).visible).toBe(false);
  });

  it("labels the count with inbox wording", () => {
    expect(needsActionBadge(1)).toEqual({
      visible: true,
      label: "1",
      srLabel: "1 conversation needs action",
    });
    expect(needsActionBadge(7).srLabel).toBe("7 conversations need action");
  });

  it("caps the label but keeps the exact number for screen readers", () => {
    const b = needsActionBadge(UNSCHEDULED_BADGE_CAP + 5);
    expect(b.label).toBe(`${UNSCHEDULED_BADGE_CAP}+`);
    expect(b.srLabel).toBe(`${UNSCHEDULED_BADGE_CAP + 5} conversations need action`);
  });
});
