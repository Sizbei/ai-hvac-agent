import { describe, it, expect } from "vitest";
import { lineTotalCents, computeOptionTotals, depositCents } from "./money";

describe("money math", () => {
  it("line total = qty × unit price, clamped non-negative", () => {
    expect(lineTotalCents({ quantity: 3, unitPriceCents: 1500 })).toBe(4500);
    expect(lineTotalCents({ quantity: 1, unitPriceCents: -10 })).toBe(0);
  });

  it("computes subtotal + tax (basis points) + total", () => {
    const t = computeOptionTotals(
      [
        { quantity: 1, unitPriceCents: 10000 },
        { quantity: 2, unitPriceCents: 2500 },
      ],
      825, // 8.25%
    );
    expect(t.subtotalCents).toBe(15000);
    expect(t.taxCents).toBe(1238); // round(15000 * 0.0825) = 1237.5 -> 1238
    expect(t.totalCents).toBe(16238);
  });

  it("zero tax when bps is 0", () => {
    const t = computeOptionTotals([{ quantity: 1, unitPriceCents: 5000 }], 0);
    expect(t).toEqual({ subtotalCents: 5000, taxCents: 0, totalCents: 5000 });
  });

  it("deposit is a clamped percentage of the total", () => {
    expect(depositCents(20000, 50)).toBe(10000);
    expect(depositCents(20000, 150)).toBe(20000); // clamp to 100%
    expect(depositCents(20000, -5)).toBe(0);
  });
});
