import { describe, it, expect } from "vitest";
import { estimateReasonResult } from "./estimate-errors";
import { isStorable } from "@/lib/http/idempotency";

describe("estimate route reasons (spec §4–§5)", () => {
  it.each([
    ["estimate_not_found", 404, "NOT_FOUND", "That estimate isn't on this job."],
    ["no_customer", 409, "NO_CUSTOMER", "Ask the office to add the customer before quoting."],
    ["not_lead", 403, "NOT_LEAD", "Only the lead technician can do that."],
    ["not_on_site", 409, "NOT_ON_SITE", "Arrive at the job first."],
    ["job_closed", 409, "JOB_CLOSED", "This job is closed."],
    ["stale", 409, "STALE", "This job changed. Try again."],
    ["already_decided", 409, "ALREADY_DECIDED", "This estimate was already decided."],
    ["estimate_expired", 409, "ESTIMATE_EXPIRED", "This estimate expired. Build a new one."],
    ["invalid_option", 400, "INVALID_OPTION", "That option isn't on this estimate."],
    ["item_inactive", 400, "INVALID_INPUT", "One of these items is no longer in the pricebook."],
    ["too_large", 400, "INVALID_INPUT", "That total is too large."],
    ["managed_externally", 409, "MANAGED_EXTERNALLY", "This job is managed in FieldPulse."],
    ["estimate_not_sold", 409, "ESTIMATE_NOT_SOLD", "Approve the estimate first."],
    ["no_lines", 409, "NO_LINES", "This estimate has no items."],
    ["already_billed", 409, "ALREADY_BILLED", "This estimate is already on an invoice."],
    ["invoice_locked", 409, "INVOICE_LOCKED", "The job's invoice is already finalized. Ask the office to bill this estimate."],
    ["invoice_changed", 409, "INVOICE_CHANGED", "The job's invoice changed. Try again."],
  ] as const)("%s → %i %s", (reason, status, code, message) => {
    expect(estimateReasonResult(reason)).toEqual({ status, envelope: { success: false, error: { message, code } } });
  });

  it("ALREADY_BILLED carries the invoice id", () => {
    expect(estimateReasonResult("already_billed", { invoiceId: "inv-1" })).toEqual({
      status: 409,
      envelope: { success: false, error: { message: "This estimate is already on an invoice.", code: "ALREADY_BILLED", details: { invoiceId: "inv-1" } } },
    });
  });

  it("stores exactly the terminal codes", () => {
    const stored = (r: Parameters<typeof estimateReasonResult>[0]) => {
      const x = estimateReasonResult(r);
      return isStorable(x.status, x.envelope);
    };
    for (const r of ["already_decided", "estimate_expired", "invalid_option", "already_billed", "no_lines", "invoice_locked", "invoice_changed", "item_inactive", "too_large"] as const) {
      expect(stored(r)).toBe(true);
    }
    for (const r of ["no_customer", "stale", "not_lead", "not_on_site", "job_closed", "estimate_not_sold", "managed_externally", "estimate_not_found"] as const) {
      expect(stored(r)).toBe(false);
    }
  });
});
