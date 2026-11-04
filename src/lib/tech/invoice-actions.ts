/**
 * What the field invoice screen may offer (spec §6.2.1 `allowed`). Pure: the
 * routes still enforce every rule; this only decides which controls show.
 * Only an on-site lead on a native job gets anything.
 */
export type InvoiceAction = "create" | "add_line" | "remove_line" | "finalize" | "record_payment" | "pay_link" | "sign";

export function invoiceAllowedActions(i: {
  state: "none" | "draft" | "open" | "paid" | "refunded";
  isLead: boolean;
  onSite: boolean;
  native: boolean;
  externalInvoice: boolean;
  balanceCents: number;
  lines: number;
  fromEstimate: boolean;
  customerHasPhone: boolean;
  signatureFresh: boolean;
}): InvoiceAction[] {
  if (!i.isLead || !i.onSite || !i.native) return [];
  const out: InvoiceAction[] = [];
  if (i.state === "none") {
    if (!i.externalInvoice) out.push("create");
  } else if (i.state === "draft") {
    if (!i.fromEstimate) out.push("add_line", "remove_line");
    if (i.lines > 0) out.push("finalize");
    if (!i.signatureFresh) out.push("sign");
  } else if (i.state === "open" && i.balanceCents > 0) {
    out.push("record_payment");
    if (i.customerHasPhone) out.push("pay_link");
  }
  return out;
}
