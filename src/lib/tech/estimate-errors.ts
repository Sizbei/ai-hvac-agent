/**
 * Reason → HTTP status / code / copy for the estimate routes (M3c spec §4–§5),
 * technician copy ("job"). Bill reasons (Task 2's BillReason) are spelled out
 * here so this module has no runtime dependency on the writers.
 */
import type { RunResult } from "@/lib/http/idempotency";

export type EstimateRouteReason =
  | "estimate_not_found" | "no_customer" | "not_lead" | "not_on_site" | "job_closed" | "stale"
  | "already_decided" | "estimate_expired" | "invalid_option" | "item_inactive" | "too_large"
  | "managed_externally" | "estimate_not_sold" | "no_lines" | "already_billed" | "invoice_locked" | "invoice_changed";

type Shape = { status: number; code: string; message: string };

const TOO_LARGE: Shape = { status: 400, code: "INVALID_INPUT", message: "That total is too large." };

const MAP: Record<EstimateRouteReason, Shape> = {
  estimate_not_found: { status: 404, code: "NOT_FOUND", message: "That estimate isn't on this job." },
  no_customer: { status: 409, code: "NO_CUSTOMER", message: "Ask the office to add the customer before quoting." },
  not_lead: { status: 403, code: "NOT_LEAD", message: "Only the lead technician can do that." },
  not_on_site: { status: 409, code: "NOT_ON_SITE", message: "Arrive at the job first." },
  job_closed: { status: 409, code: "JOB_CLOSED", message: "This job is closed." },
  stale: { status: 409, code: "STALE", message: "This job changed. Try again." },
  already_decided: { status: 409, code: "ALREADY_DECIDED", message: "This estimate was already decided." },
  estimate_expired: { status: 409, code: "ESTIMATE_EXPIRED", message: "This estimate expired. Build a new one." },
  invalid_option: { status: 400, code: "INVALID_OPTION", message: "That option isn't on this estimate." },
  item_inactive: { status: 400, code: "INVALID_INPUT", message: "One of these items is no longer in the pricebook." },
  too_large: TOO_LARGE,
  managed_externally: { status: 409, code: "MANAGED_EXTERNALLY", message: "This job is managed in FieldPulse." },
  estimate_not_sold: { status: 409, code: "ESTIMATE_NOT_SOLD", message: "Approve the estimate first." },
  no_lines: { status: 409, code: "NO_LINES", message: "This estimate has no items." },
  already_billed: { status: 409, code: "ALREADY_BILLED", message: "This estimate is already on an invoice." },
  invoice_locked: { status: 409, code: "INVOICE_LOCKED", message: "The job's invoice is already finalized. Ask the office to bill this estimate." },
  // Stored (plan ruling 11): this key's derived invoice was paid or voided; a new key derives a new invoice.
  invoice_changed: { status: 409, code: "INVOICE_CHANGED", message: "The job's invoice changed. Try again." },
};

export function estimateError(reason: EstimateRouteReason): Shape {
  return { ...MAP[reason] };
}

export function estimateReasonResult(reason: EstimateRouteReason, details?: Record<string, unknown>): RunResult {
  const { status, code, message } = MAP[reason];
  return { status, envelope: { success: false, error: details ? { message, code, details } : { message, code } } };
}
