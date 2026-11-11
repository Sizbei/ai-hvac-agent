/**
 * Default sort for each /admin/invoices tab. Pure, so the page logic is tested
 * in node. Collections tabs (overdue, unpaid) lead with the oldest debt; the
 * history tabs (all, paid) lead with the newest invoice, so years of imported
 * history don't open on a 2023 invoice.
 */
import type { InvoiceSortKey } from "./invoice-queries";

export type InvoiceFilter = "overdue" | "all" | "unpaid" | "paid";

export function defaultInvoiceSort(filter: InvoiceFilter): InvoiceSortKey {
  return filter === "overdue" || filter === "unpaid" ? "age-oldest" : "newest";
}

/** The sort in force: the one the user picked, else the tab's default. */
export function effectiveInvoiceSort(filter: InvoiceFilter, chosen: InvoiceSortKey | null): InvoiceSortKey {
  return chosen ?? defaultInvoiceSort(filter);
}
