/**
 * Exact money formatting/parsing for the admin pricebook UI. Money is stored as
 * integer cents; these helpers convert to/from dollar strings WITHOUT rounding
 * to whole dollars (unlike ops-insights-format.ts, which is for summary charts).
 */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Integer cents -> "$1,234.56". */
export function formatCentsExact(cents: number): string {
  return USD.format(cents / 100);
}

/** Business cap: $999,999.99 = 99,999,999 cents. */
export const MAX_PRICE_CENTS = 99_999_999;

/**
 * Dollar input (string from a form field, or number) -> integer cents.
 * Returns 0 for blank/unparseable input or values that exceed the business
 * cap ($999,999.99), including scientific-notation inputs like "1e15".
 * Math.round avoids float drift (e.g. 19.99 * 100 = 1998.9999...).
 */
export function parseDollarsToCents(input: string | number): number {
  const dollars = typeof input === "number" ? input : parseFloat(input);
  if (!Number.isFinite(dollars)) return 0;
  const cents = Math.round(dollars * 100);
  if (cents > MAX_PRICE_CENTS || cents < 0) return 0;
  return cents;
}

export type MoneyInputResult =
  | { readonly ok: true; readonly cents: number }
  | { readonly ok: false; readonly error: string };

export const MONEY_DECIMALS_COPY = "Use dollars and cents, like 12.50.";
export const MONEY_FORMAT_COPY = "Enter an amount in dollars, like 12.50.";
export const MONEY_BLANK_COPY = "Enter an amount.";
export const MONEY_TOO_LARGE_COPY = "That's more than $999,999.99.";

/**
 * The one parser for typed money (payment, refund, pricebook price/cost,
 * estimate line price, stock and PO cost). Strict where `parseDollarsToCents`
 * is lenient: more than 2 decimal places is REJECTED, never rounded — "1.999"
 * is far more likely a typo for 19.99 than a wish to record $2.00. Cents are
 * built from the digits, not from float math. A leading "$" and thousands
 * commas are accepted.
 */
export function parseMoneyInput(input: string): MoneyInputResult {
  const text = input.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (text === "") return { ok: false, error: MONEY_BLANK_COPY };
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) {
    return { ok: false, error: MONEY_FORMAT_COPY };
  }
  const whole = match[1] ?? "";
  const frac = match[2] ?? "";
  if (frac.length > 2) return { ok: false, error: MONEY_DECIMALS_COPY };
  if (whole.replace(/^0+/, "").length > 7) {
    return { ok: false, error: MONEY_TOO_LARGE_COPY };
  }
  const cents = Number(whole || "0") * 100 + Number(frac.padEnd(2, "0"));
  if (cents > MAX_PRICE_CENTS) return { ok: false, error: MONEY_TOO_LARGE_COPY };
  return { ok: true, cents };
}
