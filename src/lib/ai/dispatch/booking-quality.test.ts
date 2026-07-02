import { describe, it, expect } from "vitest";
import { assessBookingQuality } from "./booking-quality";
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";

const good = {
  hasAddress: true,
  hasContact: true,
  hasIssueType: true,
};

describe("assessBookingQuality", () => {
  it("passes a complete, in-area booking", () => {
    expect(assessBookingQuality({ ...good, distanceKm: 5 })).toEqual({
      clean: true,
      issues: [],
    });
  });

  it("is clean when distance is unknown (not geocoded yet)", () => {
    expect(assessBookingQuality(good).clean).toBe(true);
  });

  it("flags a missing address", () => {
    const r = assessBookingQuality({ ...good, hasAddress: false });
    expect(r.clean).toBe(false);
    expect(r.issues).toContain("no service address");
  });

  it("flags no contact method and no issue type", () => {
    const r = assessBookingQuality({
      hasAddress: true,
      hasContact: false,
      hasIssueType: false,
    });
    expect(r.clean).toBe(false);
    expect(r.issues).toEqual(["no contact method", "no issue type"]);
  });

  it("flags an out-of-service-area address", () => {
    const far = BUSINESS_BASE_LOCATION.serviceRadiusKm * 2;
    const r = assessBookingQuality({ ...good, distanceKm: far });
    expect(r.clean).toBe(false);
    expect(r.issues.some((i) => i.includes("outside the service area"))).toBe(true);
  });

  it("allows a just-inside-tolerance distance", () => {
    const edge = BUSINESS_BASE_LOCATION.serviceRadiusKm * 1.2; // < 1.25 factor
    expect(assessBookingQuality({ ...good, distanceKm: edge }).clean).toBe(true);
  });
});
