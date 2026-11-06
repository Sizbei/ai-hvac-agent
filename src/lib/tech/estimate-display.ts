/**
 * Pure display rules for the technician estimate surfaces (M3c spec §2, §7.3).
 * Client-safe: no db, no server-only imports.
 */
import { formatCentsExact } from "@/lib/admin/money-format";
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import { BILL_STATUSES, SELL_STATUSES, statusGate } from "./field-sale-statuses";
import type { EstimateBilling, TechEstimate, TechEstimateOption, TechEstimateStatus, TechEstimatesView } from "./estimate-view";

const BUSINESS_TZ = BUSINESS_BASE_LOCATION.timezone;

export function derivedStatus(status: string, expiresAt: string | Date | null, now: Date): TechEstimateStatus {
  if (status === "sold") return "sold";
  if (status === "dismissed") return "declined";
  if (status === "expired") return "expired";
  if (expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime()) return "expired";
  return "open";
}

export function estimateLabel(createdAt: string | Date, optionCount: number, timeZone: string = BUSINESS_TZ): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(new Date(createdAt));
  return `Estimate · ${day} · ${optionCount} ${optionCount === 1 ? "option" : "options"}`;
}

export const STATUS_CHIP: Record<TechEstimateStatus, string> = { open: "Open", sold: "Sold", expired: "Expired", declined: "Declined" };

export function soldOptionOf(e: Pick<TechEstimate, "soldOptionId" | "options">): TechEstimateOption | null {
  return e.options.find((o) => o.id === e.soldOptionId) ?? null;
}

export function priceSummary(e: Pick<TechEstimate, "status" | "soldOptionId" | "options">): string {
  const sold = e.status === "sold" ? soldOptionOf(e) : null;
  if (sold) return formatCentsExact(sold.totalCents);
  const totals = e.options.map((o) => o.totalCents);
  if (totals.length === 0) return formatCentsExact(0);
  const lo = Math.min(...totals);
  const hi = Math.max(...totals);
  return lo === hi ? formatCentsExact(lo) : `${formatCentsExact(lo)} – ${formatCentsExact(hi)}`;
}

export const BILLING_LINE: Record<EstimateBilling, string> = {
  job: "On the job's invoice",
  office: "Billed by the office",
  none: "Not invoiced yet",
};

export function billingOf(officeBilled: boolean, jobBilled: boolean): EstimateBilling {
  if (officeBilled) return "office";
  return jobBilled ? "job" : "none";
}

export const CREATE_BLOCKED = {
  notLead: "Only the lead technician can do that.",
  before: "Arrive at the job first.",
  closed: "This job is closed.",
  noCustomer: "Ask the office to add the customer before quoting.",
} as const;

export function createBlockedReason(p: { isLead: boolean; status: string; hasCustomer: boolean }): string | null {
  if (!p.isLead) return CREATE_BLOCKED.notLead;
  const gate = statusGate(p.status, SELL_STATUSES);
  if (gate === "job_closed") return CREATE_BLOCKED.closed;
  if (gate === "not_on_site") return CREATE_BLOCKED.before;
  return p.hasCustomer ? null : CREATE_BLOCKED.noCustomer;
}

/** Show to customer / Customer declined are offered (spec §7.2). */
export function canSell(
  view: Pick<TechEstimatesView, "isLead" | "requestStatus">, e: Pick<TechEstimate, "status"> | null,
): boolean {
  return view.isLead && e?.status === "open" && statusGate(view.requestStatus, SELL_STATUSES) === "ok";
}

export type SoldBillingView =
  /** `leave`: "Leave for the office" is offered only with no live job invoice (lead ruling, final review B P1-2). */
  | { readonly kind: "add"; readonly newInvoice: boolean; readonly leave: boolean }
  | { readonly kind: "locked" }
  | { readonly kind: "job"; readonly invoiceId: string | null }
  | { readonly kind: "office" }
  | { readonly kind: "closed" };

export function soldBillingView(
  e: Pick<TechEstimate, "billing" | "billingInvoiceId">,
  view: Pick<TechEstimatesView, "jobInvoice" | "priorInvoicePaid" | "requestStatus">,
): SoldBillingView {
  if (e.billing === "job") return { kind: "job", invoiceId: e.billingInvoiceId };
  if (e.billing === "office") return { kind: "office" };
  if (statusGate(view.requestStatus, BILL_STATUSES) !== "ok") return { kind: "closed" };
  const inv = view.jobInvoice;
  if (inv === null) return { kind: "add", newInvoice: view.priorInvoicePaid, leave: true };
  // The draft is the job's invoice; the office would answer request_has_draft, so only Add.
  if (inv.state === "draft" && !inv.hasPayment) return { kind: "add", newInvoice: false, leave: false };
  return { kind: "locked" };
}

export const SOLD_COPY = {
  locked: "The job's invoice is already finalized. Ask the office to bill this estimate.", // plan ruling 12 (spec deviation)
  newInvoice: "This goes on a new invoice.",
  added: "Added. Get the customer's signature on the invoice before finalizing.",
  overlap: "Check the invoice for parts that are also on the estimate.",
  approvalLink: "A link was also sent to the customer.",
} as const;

export function estimatesCardVisible(view: Pick<TechEstimatesView, "requestStatus" | "estimates">): boolean {
  return (BILL_STATUSES as readonly string[]).includes(view.requestStatus) || view.estimates.length > 0;
}
