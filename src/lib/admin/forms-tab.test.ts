import { describe, it, expect } from "vitest";
import { formatChangedAt, formsTabAppliesTo } from "./forms-tab";

describe("Forms tab display", () => {
  it("applies-to line", () => {
    const jt = [{ id: "a", name: "Maintenance" }, { id: "b", name: "Install (old)" }];
    expect(formsTabAppliesTo([], jt)).toBe("All requests");
    expect(formsTabAppliesTo(["a", "b"], jt)).toBe("Maintenance, Install (old)");
    expect(formsTabAppliesTo(["gone"], jt)).toBe("Some job types");
  });
  it("last changed in the business timezone", () => {
    expect(formatChangedAt("2026-11-08T03:30:00.000Z", "America/New_York")).toBe("Nov 7, 2026");
  });
});
