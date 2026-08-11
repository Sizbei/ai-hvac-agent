/**
 * displayQuantity must never let the screen contradict the money beside it.
 * Both failure directions have shipped in this repo, so both are pinned here.
 */
import { describe, it, expect } from "vitest";
import { displayQuantity } from "./line-item-display";

describe("displayQuantity", () => {
  it("shows zero for a zero-quantity component (FieldPulse sends quantity:'0')", () => {
    // Flooring at 1 here renders "1 × $5,500.00" against a $0.00 line total.
    expect(displayQuantity(0)).toBe(0);
  });

  it("shows at least one for a fraction that rounds to zero", () => {
    // Flooring at 0 here renders "0 × $100.00" against a $25.00 line total.
    expect(displayQuantity(0.25)).toBe(1);
    expect(displayQuantity(0.49)).toBe(1);
  });

  it("rounds ordinary fractional quantities", () => {
    expect(displayQuantity(2.5)).toBe(3);
    expect(displayQuantity(4.13)).toBe(4);
    expect(displayQuantity(1)).toBe(1);
  });

  it("treats negative and non-finite quantities as zero rather than inventing units", () => {
    expect(displayQuantity(-3)).toBe(0);
    expect(displayQuantity(Number.NaN)).toBe(0);
  });
});
