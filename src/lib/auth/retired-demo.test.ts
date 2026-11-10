import { describe, it, expect } from "vitest";
import { isRetiredDemoEmail } from "./retired-demo";

describe("isRetiredDemoEmail", () => {
  it("is true for the retired demo admin and technician logins", () => {
    expect(isRetiredDemoEmail("admin@demo-hvac.com")).toBe(true);
    expect(isRetiredDemoEmail("mike.johnson@demo-hvac.com")).toBe(true);
  });

  it("trims and lowercases before matching", () => {
    expect(isRetiredDemoEmail(" Admin@Demo-HVAC.com ")).toBe(true);
  });

  it("is false for a real address", () => {
    expect(isRetiredDemoEmail("chick.s@spearsservices.com")).toBe(false);
  });

  it("matches only the true domain suffix, not a lookalike", () => {
    expect(isRetiredDemoEmail("x@demo-hvac.com.evil.io")).toBe(false);
    expect(isRetiredDemoEmail("x@notdemo-hvac.com")).toBe(false);
  });

  it("is false for null, undefined and empty", () => {
    expect(isRetiredDemoEmail(null)).toBe(false);
    expect(isRetiredDemoEmail(undefined)).toBe(false);
    expect(isRetiredDemoEmail("")).toBe(false);
  });
});
