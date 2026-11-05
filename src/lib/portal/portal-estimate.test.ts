import { describe, it, expect } from "vitest";
import { portalEstimateDisplay } from "./portal-estimate";

const OPTIONS = [
  { id: "a", name: "Repair", totalCents: 31_500 },
  { id: "b", name: "Repair + tune-up", totalCents: 46_319 },
  { id: "c", name: "Replace system", totalCents: 577_613 },
];

describe("portalEstimateDisplay", () => {
  it("sold: shows the SOLD option's total and name, not the headline max", () => {
    const d = portalEstimateDisplay({
      status: "sold",
      totalCents: 577_613,
      soldOptionId: "b",
      awaitingApproval: false,
      options: OPTIONS,
    });
    expect(d.amount).toEqual({ kind: "single", cents: 46_319 });
    expect(d.statusLabel).toBe("Approved");
    expect(d.optionName).toBe("Repair + tune-up");
  });

  it("sold without a matching option (e.g. synced): falls back to the stored total", () => {
    const d = portalEstimateDisplay({
      status: "sold",
      totalCents: 12_000,
      soldOptionId: null,
      awaitingApproval: false,
      options: [],
    });
    expect(d.amount).toEqual({ kind: "single", cents: 12_000 });
    expect(d.optionName).toBeNull();
  });

  it("open with several options: the low-high range, labelled with the count", () => {
    const d = portalEstimateDisplay({
      status: "open",
      totalCents: 577_613,
      soldOptionId: null,
      awaitingApproval: true,
      options: OPTIONS,
    });
    expect(d.amount).toEqual({ kind: "range", minCents: 31_500, maxCents: 577_613 });
    expect(d.optionCount).toBe(3);
    expect(d.statusLabel).toBe("Awaiting your approval");
  });

  it("open with one option: that option's total", () => {
    const d = portalEstimateDisplay({
      status: "open",
      totalCents: 99_999,
      soldOptionId: null,
      awaitingApproval: false,
      options: [OPTIONS[1]],
    });
    expect(d.amount).toEqual({ kind: "single", cents: 46_319 });
    expect(d.statusLabel).toBe("Open");
  });

  it("never shows a raw enum", () => {
    for (const status of ["dismissed", "expired", "something_new"]) {
      const d = portalEstimateDisplay({
        status,
        totalCents: 1,
        soldOptionId: null,
        awaitingApproval: false,
        options: [],
      });
      expect(d.statusLabel).toMatch(/^(Declined|Expired|Open)$/);
    }
  });
});
