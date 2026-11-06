/**
 * Field estimate input rules (M3c spec §5.1–§5.2), shared by the routes, the
 * writers and the builder. Pure, no imports: safe in a client bundle.
 */
export const MAX_OPTIONS = 3;
export const MAX_LINES_PER_OPTION = 40;
export const MAX_QUANTITY = 999;
export const MAX_OPTION_NAME = 40;
export const MIN_SIGNATURE = 2;
export const MAX_SIGNATURE = 200;
/** signature_name the office "Mark sold" path writes; never a customer's typed name. */
export const OFFICE_SIGNATURE = "(admin)";
export const INT32_MAX = 2_147_483_647;

export interface CreateLineInput { readonly pricebookItemId: string; readonly quantity: number }
export interface CreateOptionInput { readonly name: string; readonly lines: readonly CreateLineInput[] }
export interface CreateEstimateInput { readonly options: readonly CreateOptionInput[] }

export interface PricedItem { readonly id: string; readonly name: string; readonly priceCents: number; readonly costCents: number }
export interface BuiltOption {
  readonly id: string; readonly name: string; readonly sortOrder: number;
  readonly subtotalCents: number; readonly taxCents: number; readonly totalCents: number;
}
export interface BuiltLine {
  readonly id: string; readonly optionId: string; readonly pricebookItemId: string; readonly name: string;
  readonly quantity: number; readonly unitPriceCents: number; readonly costCents: number; readonly lineTotalCents: number;
}

export function hasDuplicateNames(names: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const n of names) {
    const k = n.trim().toLowerCase();
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

/** The portal's rule: at least 2 characters once trimmed, at most 200, never the office marker. */
export function signatureNameOk(raw: string): boolean {
  const name = raw.trim();
  return name.length >= MIN_SIGNATURE && name.length <= MAX_SIGNATURE && name !== OFFICE_SIGNATURE;
}

/**
 * Snapshot each line from the org's ACTIVE pricebook items (`items`, keyed by
 * lower-case id) and total each option: subtotal = Σ quantity × regular price,
 * tax = round(subtotal × bps / 10000). Ids come from `mintId` in build order
 * (option, then its lines), so v7 ids read back ORDER BY id in build order.
 */
export function buildFieldEstimate(
  input: CreateEstimateInput,
  items: ReadonlyMap<string, PricedItem>,
  taxBps: number,
  mintId: () => string,
): { ok: true; options: BuiltOption[]; lines: BuiltLine[]; totalCents: number } | { ok: false; reason: "item_inactive" | "too_large" } {
  const options: BuiltOption[] = [];
  const lines: BuiltLine[] = [];
  for (const [sortOrder, opt] of input.options.entries()) {
    const optionId = mintId();
    let subtotal = 0;
    for (const l of opt.lines) {
      const item = items.get(l.pricebookItemId.toLowerCase());
      if (!item) return { ok: false, reason: "item_inactive" };
      const lineTotal = l.quantity * item.priceCents;
      subtotal += lineTotal;
      if (subtotal > INT32_MAX) return { ok: false, reason: "too_large" };
      lines.push({
        id: mintId(), optionId, pricebookItemId: item.id, name: item.name, quantity: l.quantity,
        unitPriceCents: item.priceCents, costCents: item.costCents, lineTotalCents: lineTotal,
      });
    }
    const tax = Math.round((subtotal * taxBps) / 10000);
    if (subtotal + tax > INT32_MAX) return { ok: false, reason: "too_large" };
    options.push({ id: optionId, name: opt.name.trim(), sortOrder, subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax });
  }
  return { ok: true, options, lines, totalCents: Math.max(...options.map((o) => o.totalCents)) };
}
