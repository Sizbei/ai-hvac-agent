import { describe, it, expect } from "vitest";
import {
  getPlan,
  isValidPlanId,
  DEFAULT_PLAN,
  PLANS,
  ALL_PLANS,
} from "./plans";

describe("plans catalog", () => {
  it("returns the default/free tier for a null/undefined/blank plan id", () => {
    expect(getPlan(null).id).toBe("free");
    expect(getPlan(undefined).id).toBe("free");
    expect(getPlan("").id).toBe("free");
    expect(getPlan(null)).toBe(DEFAULT_PLAN);
  });

  it("falls back to the default tier for an unknown plan id (never unlimited)", () => {
    expect(getPlan("does-not-exist").id).toBe("free");
  });

  it("resolves each real plan id to its plan", () => {
    for (const plan of PLANS) {
      expect(getPlan(plan.id).id).toBe(plan.id);
    }
  });

  it("validates plan ids", () => {
    expect(isValidPlanId("starter")).toBe(true);
    expect(isValidPlanId("free")).toBe(true);
    expect(isValidPlanId("nope")).toBe(false);
  });

  it("every plan has integer-cent pricing and a positive staff cap", () => {
    for (const plan of ALL_PLANS) {
      expect(Number.isInteger(plan.priceCents)).toBe(true);
      expect(plan.priceCents).toBeGreaterThanOrEqual(0);
      expect(plan.entitlements.maxStaff).toBeGreaterThan(0);
      expect(plan.interval).toBe("month");
    }
  });
});
