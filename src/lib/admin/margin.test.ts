import { describe, it, expect } from "vitest";
import { computeMargin, rollUpMargin } from "./margin";

describe("computeMargin", () => {
  it("positive margin: revenue above cost", () => {
    const m = computeMargin(10000, 6000);
    expect(m.marginCents).toBe(4000);
    expect(m.marginPct).toBeCloseTo(0.4, 10);
  });

  it("zero revenue yields 0 pct (no divide-by-zero)", () => {
    const m = computeMargin(0, 0);
    expect(m.marginCents).toBe(0);
    expect(m.marginPct).toBe(0);
  });

  it("zero revenue with cost: negative margin cents, 0 pct", () => {
    const m = computeMargin(0, 5000);
    expect(m.marginCents).toBe(-5000);
    expect(m.marginPct).toBe(0);
  });

  it("cost exceeds revenue: negative margin + negative pct", () => {
    const m = computeMargin(8000, 10000);
    expect(m.marginCents).toBe(-2000);
    expect(m.marginPct).toBeCloseTo(-0.25, 10);
  });

  it("zero cost: 100% margin", () => {
    const m = computeMargin(5000, 0);
    expect(m.marginCents).toBe(5000);
    expect(m.marginPct).toBe(1);
  });
});

describe("rollUpMargin", () => {
  it("sums line revenue + cost, then computes margin over the set", () => {
    const r = rollUpMargin([
      { lineTotalCents: 10000, costCents: 6000 },
      { lineTotalCents: 5000, costCents: 2000 },
    ]);
    expect(r.revenueCents).toBe(15000);
    expect(r.costCents).toBe(8000);
    expect(r.marginCents).toBe(7000);
    expect(r.marginPct).toBeCloseTo(7000 / 15000, 10);
  });

  it("empty set: all zeros, 0 pct", () => {
    const r = rollUpMargin([]);
    expect(r).toEqual({
      revenueCents: 0,
      costCents: 0,
      marginCents: 0,
      marginPct: 0,
    });
  });

  it("rolls up to a negative margin when total cost exceeds total revenue", () => {
    const r = rollUpMargin([
      { lineTotalCents: 1000, costCents: 1500 },
      { lineTotalCents: 2000, costCents: 2500 },
    ]);
    expect(r.revenueCents).toBe(3000);
    expect(r.costCents).toBe(4000);
    expect(r.marginCents).toBe(-1000);
    expect(r.marginPct).toBeCloseTo(-1000 / 3000, 10);
  });
});
