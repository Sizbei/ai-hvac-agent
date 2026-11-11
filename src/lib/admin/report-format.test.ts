import { describe, it, expect } from "vitest";
import { formatRatio, formatRate, visibleLeadSources, firstAddressLine, locationDisplayLabel, collectedTile, closeRateSublabel, leadSourceLabel } from "./report-format";

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

describe("formatRatio", () => {
  it("dashes an empty denominator and rounds otherwise", () => {
    expect(formatRatio(0, 0)).toBe("—");
    expect(formatRatio(0.456, 10)).toBe("46%");
    expect(formatRatio(0, 10)).toBe("0%");
  });
});

describe("collectedTile", () => {
  it("adds FieldPulse payments to money taken here and names both", () => {
    const t = collectedTile({ grossCollectedCents: 338785, refundedCents: 5000, netCollectedCents: 333785, fieldpulseCollectedCents: 9_876_543 }, 30);
    expect(t.label).toBe("Collected (last 30 days)");
    expect(t.valueCents).toBe(10_210_328);
    expect(t.sublabel).toBe("$98,765.43 FieldPulse payments + $3,337.85 taken here, less refunds");
  });

  it("without FieldPulse money reads as before", () => {
    const t = collectedTile({ grossCollectedCents: 10000, refundedCents: 2500, netCollectedCents: 7500, fieldpulseCollectedCents: 0 }, 90);
    expect(t).toEqual({ label: "Collected (last 90 days)", valueCents: 7500, sublabel: "$100.00 collected − $25.00 refunded" });
  });
});

describe("closeRateSublabel", () => {
  it("counts every estimate, not only decided ones", () => {
    expect(closeRateSublabel(7, 115)).toBe("7 sold of 115 estimates");
    expect(closeRateSublabel(0, 1)).toBe("0 sold of 1 estimate");
  });
});

describe("leadSourceLabel", () => {
  it("never shows Unknown for a missing lead source", () => {
    expect(leadSourceLabel("unknown")).toBe("Not recorded");
  });
  it("maps known codes and humanizes unmapped ones", () => {
    expect(leadSourceLabel("repeat_customer")).toBe("Repeat customer");
    expect(leadSourceLabel("trade_show")).toBe("Trade show");
  });
});
