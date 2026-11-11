import { describe, it, expect } from "vitest";
import { lineQuantity, lineQuantityLabel } from "./line-quantity";

describe("lineQuantity", () => {
  it("keeps a quantity whose money adds up", () => {
    expect(lineQuantity({ quantity: 3, unitPriceCents: 2500, lineTotalCents: 7500 })).toBe(3);
  });

  it("recovers a fractional FieldPulse quantity stored rounded", () => {
    expect(lineQuantity({ quantity: 5, unitPriceCents: 9000, lineTotalCents: 40950 })).toBe(4.55);
    expect(lineQuantity({ quantity: 3, unitPriceCents: 25000, lineTotalCents: 62500 })).toBe(2.5);
    expect(lineQuantity({ quantity: 1, unitPriceCents: 10000, lineTotalCents: 5000 })).toBe(0.5);
  });

  it("keeps the stored quantity when rounding can't explain the gap (a discount)", () => {
    expect(lineQuantity({ quantity: 2, unitPriceCents: 10000, lineTotalCents: 10000 })).toBe(2);
  });

  it("keeps the stored quantity for a $0 or negative-total line", () => {
    expect(lineQuantity({ quantity: 1, unitPriceCents: 0, lineTotalCents: 0 })).toBe(1);
    expect(lineQuantity({ quantity: 1, unitPriceCents: 500, lineTotalCents: -500 })).toBe(1);
  });

  it("works for negative unit prices (credits)", () => {
    expect(lineQuantity({ quantity: 1, unitPriceCents: -92842, lineTotalCents: -92842 })).toBe(1);
  });
});

describe("lineQuantityLabel", () => {
  it("prints the number without trailing zeros", () => {
    expect(lineQuantityLabel({ quantity: 3, unitPriceCents: 25000, lineTotalCents: 62500 })).toBe("2.5");
    expect(lineQuantityLabel({ quantity: 4, unitPriceCents: 100, lineTotalCents: 400 })).toBe("4");
  });
});
