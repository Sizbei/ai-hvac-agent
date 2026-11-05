/**
 * Pure parsing for the job page's typed-in material price (dollars). Blank
 * means "no price" (the line saves at $0 for the office to price).
 */
import { MAX_PRICE_CENTS } from "@/lib/admin/money-format";

export type ManualPrice =
  | { readonly ok: true; readonly cents: number | null }
  | { readonly ok: false; readonly message: string };

const DOLLARS = /^\$?\s*(\d{1,7})(?:\.(\d{1,2}))?$/;

export function parseManualPrice(input: string, quantity: number): ManualPrice {
  const raw = input.trim().replace(/,/g, "");
  if (raw === "") return { ok: true, cents: null };
  const m = DOLLARS.exec(raw);
  if (!m) return { ok: false, message: "Enter a price like 42.50." };
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  if (cents > MAX_PRICE_CENTS || cents * qty > MAX_PRICE_CENTS) {
    return { ok: false, message: "That price is too high." };
  }
  return { ok: true, cents };
}
