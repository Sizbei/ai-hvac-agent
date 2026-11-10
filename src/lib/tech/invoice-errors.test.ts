import { describe, it, expect } from "vitest";
import { fieldError, reasonResult, type RouteReason } from "./invoice-errors";

// Spec §6.3, verbatim.
const TABLE: [RouteReason, number, string, string][] = [
  ["managed_externally", 409, "MANAGED_EXTERNALLY", "This job is managed in FieldPulse."],
  ["external_invoice", 409, "EXTERNAL_INVOICE", "This job's invoice lives in FieldPulse."],
  ["not_lead", 403, "NOT_LEAD", "Only the lead technician can do that."],
  ["not_on_site", 409, "NOT_ON_SITE", "Arrive at the job before invoicing."],
  ["invoice_not_found", 404, "NOT_FOUND", "No invoice on this job yet."],
  ["invoice_voided", 409, "INVOICE_VOIDED", "The office voided that invoice. Create a new one."],
  ["invoice_locked", 409, "INVOICE_LOCKED", "This invoice is finalized. Changes need the office."],
  ["no_lines", 409, "NO_LINES", "Add at least one item first."],
  ["already_billed", 409, "ALREADY_BILLED", "That material is already on an invoice."],
  ["item_not_found", 404, "ITEM_NOT_FOUND", "That item isn't available."],
  ["invoice_not_chargeable", 409, "INVOICE_NOT_CHARGEABLE", "This invoice can't take a payment right now."],
  ["exceeds_balance", 422, "EXCEEDS_BALANCE", "That's more than the balance due."],
  ["synced_read_only", 409, "INVOICE_SYNCED_READ_ONLY", "This invoice is managed in FieldPulse."],
  ["no_contact", 409, "NO_CONTACT", "No phone (or email) on file for this customer."],
  ["no_template", 409, "NO_TEMPLATE", "Pay link messages aren't set up. Ask the office."],
  ["cooldown", 409, "COOLDOWN", "A link went out a moment ago."],
  ["pay_links_off", 403, "PAY_LINKS_OFF", "Pay links are turned off for this account."],
  ["payment_id_conflict", 409, "ID_CONFLICT", "That payment token was already used. Try again."],
  ["refund_id_conflict", 409, "ID_CONFLICT", "That payment token was already used. Try again."],
  ["stale", 409, "STALE", "This job changed. Refresh and try again."],
  ["from_estimate", 409, "FROM_ESTIMATE", "This item came from the approved estimate. Ask the office to change it."],
];

describe("fieldError", () => {
  it.each(TABLE)("%s → %i %s", (reason, status, code, message) => {
    expect(fieldError(reason)).toEqual({ status, code, message });
  });

  it("covers every reason exactly once", () => {
    expect(new Set(TABLE.map(([r]) => r)).size).toBe(21);
  });
});

describe("reasonResult", () => {
  it("builds the idempotency run result with the error envelope", () => {
    expect(reasonResult("no_lines")).toEqual({
      status: 409,
      envelope: { success: false, error: { message: "Add at least one item first.", code: "NO_LINES" } },
    });
    expect(reasonResult("item_not_found").status).toBe(404);
  });
});
