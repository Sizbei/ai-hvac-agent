import { describe, it, expect } from "vitest";
import { formatRate, visibleLeadSources, firstAddressLine, locationDisplayLabel } from "./report-format";

describe("formatRate", () => {
  it("renders a dash when nothing was decided", () => {
    expect(formatRate(0, 0)).toBe("—");
  });
  it("renders a real zero as 0%", () => {
    expect(formatRate(0, 4)).toBe("0%");
  });
  it("renders the percentage", () => {
    expect(formatRate(33.3, 3)).toBe("33.3%");
  });
});

describe("visibleLeadSources", () => {
  it("drops all-zero sources and keeps any with leads, bookings or revenue", () => {
    const rows = [
      { source: "google", leads: 0, booked: 0, revenueCents: 0 },
      { source: "yelp", leads: 2, booked: 0, revenueCents: 0 },
      { source: "referral", leads: 0, booked: 1, revenueCents: 0 },
      { source: "other", leads: 0, booked: 0, revenueCents: -500 },
    ];
    expect(visibleLeadSources(rows).map((r) => r.source)).toEqual(["yelp", "referral", "other"]);
  });
});

describe("firstAddressLine", () => {
  it("takes the part before the first comma or newline", () => {
    expect(firstAddressLine("12 Oak St, Johnson City, TN")).toBe("12 Oak St");
    expect(firstAddressLine("12 Oak St\nJohnson City")).toBe("12 Oak St");
  });
  it("returns null for empty input", () => {
    expect(firstAddressLine(null)).toBeNull();
    expect(firstAddressLine("  ")).toBeNull();
  });
});

describe("locationDisplayLabel", () => {
  it("prefers the label, then the zone, then the address", () => {
    expect(locationDisplayLabel({ label: "Warehouse B", zone: "North", address: "1 A St" })).toBe("Warehouse B");
    expect(locationDisplayLabel({ label: null, zone: "North", address: "1 A St" })).toBe("North");
    expect(locationDisplayLabel({ label: " ", zone: null, address: "1 A St, Town" })).toBe("1 A St");
  });
  it("names an erased address plainly", () => {
    expect(locationDisplayLabel({ label: null, zone: null, address: "[deleted]" })).toBe("Erased address");
  });
  it("never falls back to the bare word Location", () => {
    expect(locationDisplayLabel({ label: null, zone: null, address: null })).toBe("Address not on file");
  });
});
