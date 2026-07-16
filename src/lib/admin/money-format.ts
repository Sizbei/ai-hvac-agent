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
