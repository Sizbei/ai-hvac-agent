import { describe, it, expect } from "vitest";
import { parseManualPrice } from "./material-form";

describe("parseManualPrice", () => {
  it("blank is no price", () => {
    expect(parseManualPrice("", 1)).toEqual({ ok: true, cents: null });
    expect(parseManualPrice("   ", 1)).toEqual({ ok: true, cents: null });
  });
  it("dollars and cents to integer cents", () => {
    expect(parseManualPrice("42.5", 1)).toEqual({ ok: true, cents: 4250 });
    expect(parseManualPrice("$19.99", 1)).toEqual({ ok: true, cents: 1999 });
    expect(parseManualPrice("1,250", 1)).toEqual({ ok: true, cents: 125000 });
    expect(parseManualPrice("0", 1)).toEqual({ ok: true, cents: 0 });
  });
  it("rejects negatives, letters and extra decimals", () => {
    for (const bad of ["-5", "abc", "1.234", "1e5"]) {
      expect(parseManualPrice(bad, 1)).toEqual({ ok: false, message: "Enter a price like 42.50." });
    }
  });
  it("caps the unit price and the line total", () => {
    expect(parseManualPrice("1000000", 1)).toEqual({ ok: false, message: "That price is too high." });
    expect(parseManualPrice("600000", 2)).toEqual({ ok: false, message: "That price is too high." });
    expect(parseManualPrice("999999.99", 1)).toEqual({ ok: true, cents: 99_999_999 });
  });
});
