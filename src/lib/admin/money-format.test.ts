import { describe, it, expect } from "vitest";
import {
  parseMoneyInput,
  MONEY_DECIMALS_COPY,
  MONEY_FORMAT_COPY,
  MONEY_BLANK_COPY,
  MONEY_TOO_LARGE_COPY,
} from "./money-format";

describe("parseMoneyInput", () => {
  it.each([
    ["12.50", 1250],
    ["12.5", 1250],
    ["12", 1200],
    ["12.", 1200],
    [".5", 50],
    ["0.07", 7],
    ["19.99", 1999],
    ["$1,234.56", 123456],
    ["  45 ", 4500],
    ["0", 0],
    ["999999.99", 99_999_999],
  ])("%s → %d cents", (input, cents) => {
    expect(parseMoneyInput(input)).toEqual({ ok: true, cents });
  });

  it("rejects more than two decimal places instead of rounding", () => {
    expect(parseMoneyInput("1.999")).toEqual({ ok: false, error: MONEY_DECIMALS_COPY });
    expect(parseMoneyInput("19.995")).toEqual({ ok: false, error: MONEY_DECIMALS_COPY });
    expect(parseMoneyInput("5.000")).toEqual({ ok: false, error: MONEY_DECIMALS_COPY });
  });

  it("asks for an amount when blank", () => {
    expect(parseMoneyInput("")).toEqual({ ok: false, error: MONEY_BLANK_COPY });
    expect(parseMoneyInput("  $ ")).toEqual({ ok: false, error: MONEY_BLANK_COPY });
  });

  it.each(["-5", "abc", "1e5", "12.3.4", ".", "1 000"])(
    "rejects %s as not an amount",
    (input) => {
      expect(parseMoneyInput(input)).toEqual({ ok: false, error: MONEY_FORMAT_COPY });
    },
  );

  it("rejects amounts past the $999,999.99 cap", () => {
    expect(parseMoneyInput("1000000")).toEqual({ ok: false, error: MONEY_TOO_LARGE_COPY });
    expect(parseMoneyInput("99999999999999999999")).toEqual({
      ok: false,
      error: MONEY_TOO_LARGE_COPY,
    });
  });

  it("builds cents from digits, not float math", () => {
    // 1.15 * 100 = 114.99999999999999 in floating point.
    expect(parseMoneyInput("1.15")).toEqual({ ok: true, cents: 115 });
    expect(parseMoneyInput("4.35")).toEqual({ ok: true, cents: 435 });
  });
});
