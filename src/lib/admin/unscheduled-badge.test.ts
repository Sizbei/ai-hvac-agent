import { describe, it, expect } from "vitest";
import {
  unscheduledBadge,
  UNSCHEDULED_BADGE_CAP,
} from "./unscheduled-badge";

describe("unscheduledBadge", () => {
  it("hides the badge when there is nothing to place", () => {
    const badge = unscheduledBadge(0);
    expect(badge.visible).toBe(false);
    expect(badge.label).toBe("");
    expect(badge.srLabel).toBe("");
  });

  it("shows an exact count and singular noun for one job", () => {
    const badge = unscheduledBadge(1);
    expect(badge.visible).toBe(true);
    expect(badge.label).toBe("1");
    expect(badge.srLabel).toBe("1 unscheduled job");
  });

  it("uses the plural noun for more than one job", () => {
    const badge = unscheduledBadge(3);
    expect(badge.label).toBe("3");
    expect(badge.srLabel).toBe("3 unscheduled jobs");
  });

  it("renders the exact count at the cap", () => {
    const badge = unscheduledBadge(UNSCHEDULED_BADGE_CAP);
    expect(badge.label).toBe(String(UNSCHEDULED_BADGE_CAP));
  });

  it("renders 'N+' above the cap", () => {
    const badge = unscheduledBadge(UNSCHEDULED_BADGE_CAP + 5);
    expect(badge.label).toBe(`${UNSCHEDULED_BADGE_CAP}+`);
    // The accessible label still reports the true count.
    expect(badge.srLabel).toBe(
      `${UNSCHEDULED_BADGE_CAP + 5} unscheduled jobs`,
    );
  });

  it("treats negative or non-finite counts as zero (defensive boundary)", () => {
    expect(unscheduledBadge(-2).visible).toBe(false);
    expect(unscheduledBadge(Number.NaN).visible).toBe(false);
    expect(unscheduledBadge(Number.POSITIVE_INFINITY).visible).toBe(false);
  });

  it("floors fractional counts", () => {
    expect(unscheduledBadge(2.9).label).toBe("2");
  });
});
