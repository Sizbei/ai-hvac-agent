/**
 * Reason → HTTP status/code/message for the field invoice routes (spec §6.3,
 * verbatim). The technician app says "job"; the office copy says "request".
 */
import type { FieldReason } from "@/lib/admin/invoice-field-writes";
import type { RunResult } from "@/lib/http/idempotency";

export type RouteReason = FieldReason | "not_on_site" | "no_contact" | "no_template" | "cooldown" | "pay_links_off";

type FieldErrorShape = { status: number; code: string; message: string };

const ID_CONFLICT: FieldErrorShape = { status: 409, code: "ID_CONFLICT", message: "That payment token was already used. Try again." };

const MAP: Record<RouteReason, FieldErrorShape> = {
  managed_externally: { status: 409, code: "MANAGED_EXTERNALLY", message: "This job is managed in FieldPulse." },
  external_invoice: { status: 409, code: "EXTERNAL_INVOICE", message: "This job's invoice lives in FieldPulse." },
  not_lead: { status: 403, code: "NOT_LEAD", message: "Only the lead technician can do that." },
  not_on_site: { status: 409, code: "NOT_ON_SITE", message: "Arrive at the job before invoicing." },
  invoice_not_found: { status: 404, code: "NOT_FOUND", message: "No invoice on this job yet." },
  invoice_voided: { status: 409, code: "INVOICE_VOIDED", message: "The office voided that invoice. Create a new one." },
  invoice_locked: { status: 409, code: "INVOICE_LOCKED", message: "This invoice is finalized. Changes need the office." },
  no_lines: { status: 409, code: "NO_LINES", message: "Add at least one item first." },
  already_billed: { status: 409, code: "ALREADY_BILLED", message: "That material is already on an invoice." },
  item_not_found: { status: 404, code: "ITEM_NOT_FOUND", message: "That item isn't available." },
  invoice_not_chargeable: { status: 409, code: "INVOICE_NOT_CHARGEABLE", message: "This invoice can't take a payment right now." },
  exceeds_balance: { status: 422, code: "EXCEEDS_BALANCE", message: "That's more than the balance due." },
  synced_read_only: { status: 409, code: "INVOICE_SYNCED_READ_ONLY", message: "This invoice is managed in FieldPulse." },
  no_contact: { status: 409, code: "NO_CONTACT", message: "No phone (or email) on file for this customer." },
  no_template: { status: 409, code: "NO_TEMPLATE", message: "Pay link messages aren't set up. Ask the office." },
  cooldown: { status: 409, code: "COOLDOWN", message: "A link went out a moment ago." },
  pay_links_off: { status: 403, code: "PAY_LINKS_OFF", message: "Pay links are turned off for this account." },
  payment_id_conflict: ID_CONFLICT,
  refund_id_conflict: ID_CONFLICT,
  stale: { status: 409, code: "STALE", message: "This job changed. Refresh and try again." },
  from_estimate: { status: 409, code: "FROM_ESTIMATE", message: "This item came from the approved estimate. Ask the office to change it." },
};

export function fieldError(reason: RouteReason): FieldErrorShape {
  return { ...MAP[reason] };
}

/** The idempotency `run` result for a refused write. */
export function reasonResult(reason: RouteReason): RunResult {
  const { status, code, message } = MAP[reason];
  return { status, envelope: { success: false, error: { message, code } } };
}
