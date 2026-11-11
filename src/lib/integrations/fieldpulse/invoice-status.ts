/**
 * FieldPulse invoice status → native `invoices.state`. PURE module (no db or
 * server imports) so the sync, the backfill script and the tests share it.
 *
 * What FieldPulse actually sends (live-verified 2026-11-11, company 182499):
 *  - `status` is a legacy integer that does not line up with the company's
 *    workflow (a "Void" invoice carries 6, an "Invoice Draft" one -1). It is
 *    never mapped.
 *  - `status_id` is the invoice's place in the company's own status workflow.
 *    GET /invoices/status-workflows lists every workflow with its statuses;
 *    each status has a company name and a fixed FieldPulse bucket `type`:
 *    invoice_draft, invoice_invoiced, invoice_sent, invoice_partially_paid,
 *    invoice_paid, invoice_void. The response has the same shape as the
 *    estimate workflows, so the lookup builder is shared.
 *
 * Mapping (the bucket type decides, never the company's label):
 *  - invoice_draft → draft (never sent, owes nothing yet)
 *  - invoice_invoiced, invoice_sent, invoice_partially_paid → open
 *  - invoice_paid → paid
 *  - invoice_void → void
 *
 * Anything else — the workflows could not be read, came back empty, the id is
 * in no current workflow, or the type is one we do not know — gives null, and
 * the caller keeps the stored state. Guessing a money state is how drafts and
 * voids came to be counted as money owed.
 */
import {
  buildFpEstimateStatusLookup,
  type FpEstimateStatusEntry,
} from "./estimate-status";

export type NativeFpInvoiceState = "draft" | "open" | "paid" | "void";

export type FpInvoiceStatusEntry = FpEstimateStatusEntry;

/** status_id → company name + FieldPulse bucket type. */
export type FpInvoiceStatusLookup = ReadonlyMap<string, FpInvoiceStatusEntry>;

/** Build the lookup from the raw `response` of GET /invoices/status-workflows. */
export const buildFpInvoiceStatusLookup: (workflows: unknown) => FpInvoiceStatusLookup =
  buildFpEstimateStatusLookup;

const STATE_BY_TYPE: Readonly<Record<string, NativeFpInvoiceState>> = {
  invoice_draft: "draft",
  invoice_invoiced: "open",
  invoice_sent: "open",
  invoice_partially_paid: "open",
  invoice_paid: "paid",
  invoice_void: "void",
};

function idString(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

/**
 * The native state FieldPulse's workflow says, or null to keep the stored
 * state. An empty lookup is a failed lookup, not "every id is unknown".
 */
export function fpInvoiceStateFromStatus(
  statusId: unknown,
  lookup: FpInvoiceStatusLookup | null | undefined,
): NativeFpInvoiceState | null {
  if (!lookup || lookup.size === 0) return null;
  const id = idString(statusId);
  const type = id ? lookup.get(id)?.type : null;
  return (type && STATE_BY_TYPE[type]) || null;
}

/**
 * The service_requests.invoice_status word for a native state, in the
 * vocabulary syncInvoiceStatus maps (draft → none, open → sent).
 */
export function requestInvoiceStatusWord(state: NativeFpInvoiceState): "draft" | "sent" | "paid" | "void" {
  return state === "open" ? "sent" : state;
}
