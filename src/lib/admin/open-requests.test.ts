import { describe, it, expect } from "vitest";
import { openRequestTotals, importedSuffix, openRequestCaption } from "./open-requests";
import type { DashboardStats } from "./types";

const base: DashboardStats = {
  pending: 11, assignedToday: 2, inProgress: 1, completedToday: 0, scheduled: 7, onHold: 0,
  emergencyOpen: 0, afterHoursToday: 0, importedPending: 58, assigned: 14,
  importedScheduled: 0, importedAssigned: 10, importedInProgress: 16, importedOnHold: 0,
};

describe("openRequestTotals", () => {
  it("sums the five status buckets; assignedToday is not part of it", () => {
    // Dev default org on 2026-11-05: 33 native + 84 imported = 117.
    expect(openRequestTotals(base)).toEqual({ native: 33, imported: 84, total: 117 });
  });
});

describe("importedSuffix", () => {
  it("hides zero", () => {
    expect(importedSuffix(0)).toBeUndefined();
    expect(importedSuffix(3)).toBe("+3 imported");
  });
});

describe("openRequestCaption", () => {
  it("explains the split when there are imports", () => {
    expect(openRequestCaption({ native: 33, imported: 84, total: 117 })).toBe(
      "117 open requests: 33 booked here, 84 imported from FieldPulse or Housecall Pro",
    );
  });
  it("is short without imports, singular for one", () => {
    expect(openRequestCaption({ native: 1, imported: 0, total: 1 })).toBe("1 open request");
  });
});
