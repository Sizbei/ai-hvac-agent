/**
 * Copy and small rules for the technician estimate page and the customer view
 * (M3c spec §7.2–§7.3). The customer view never shows server text: any failure
 * reads CUSTOMER_COPY.failed and the technician sees the reason afterwards.
 */
import { formatCentsExact } from "@/lib/admin/money-format";
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import type { WriteOutcome } from "./invoice-key-state";
import type { TechEstimate, TechEstimateOption } from "./estimate-view";

export const CUSTOMER_COPY = {
  choose: "Choose an option",
  nameLabel: "Type your full name to sign",
  consent: "By typing your name and approving, you authorize the selected work.",
  approve: "Approve",
  approving: "Approving…",
  goBack: "Go back",
  notNow: "Not now",
  checking: "Checking…",
  approved: "Approved. Thank you.",
  handBack: "Hand back to technician",
  failed: "Something went wrong. Please hand the phone back to your technician.",
  handBackPrompt: "Please hand the phone back to your technician.",
  imTech: "I'm the technician",
} as const;

export const DECLINE_COPY = {
  button: "Customer declined",
  confirm: "Mark this estimate as declined?",
  yes: "Mark declined",
  no: "Go back",
} as const;

export const SOLD_ACTIONS = {
  show: "Show to customer",
  add: "Add to the job's invoice",
  adding: "Adding…",
  leave: "Leave for the office",
  openInvoice: "Open invoice",
} as const;

export function customerHeading(customerDisplayName: string | null): string {
  return customerDisplayName ? `Estimate for ${customerDisplayName}` : "Your estimate";
}

/** The portal's rule: nothing pre-selected with two or more options. */
export function initialChoice(options: readonly { readonly id: string }[]): string | null {
  return options.length === 1 ? options[0]!.id : null;
}

export function previewLines<T>(lines: readonly T[], expanded: boolean): readonly T[] {
  return expanded ? lines : lines.slice(0, 3);
}

export function showAllLabel(count: number): string | null {
  return count > 3 ? `Show all ${count} items` : null;
}

export function footerSummary(o: Pick<TechEstimateOption, "name" | "totalCents"> | null): string {
  return o ? `${o.name} · ${formatCentsExact(o.totalCents)}` : CUSTOMER_COPY.choose;
}

export function approveConfirmCopy(name: string, totalCents: number): string {
  return `Approve ${name} for ${formatCentsExact(totalCents)}?`;
}

/** First answer to a sell: success, check by refetch (unknown), or failed. */
export function saleResult(outcome: WriteOutcome): "success" | "check" | "failed" {
  if (outcome === "success_refetch" || outcome === "already_saved_refetch") return "success";
  if (outcome === "retry_same_key_after_refetch" || outcome === "wait_then_refetch") return "check";
  return "failed";
}

export function afterCheck(e: Pick<TechEstimate, "status" | "soldByMe" | "soldOptionId"> | null, chosenOptionId: string): boolean {
  return e !== null && e.status === "sold" && e.soldByMe && e.soldOptionId === chosenOptionId;
}

export function approvedLine(signedAt: string | null, optionName: string | null, timeZone: string = BUSINESS_BASE_LOCATION.timezone): string {
  const when = signedAt
    ? new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(signedAt))
    : null;
  return ["Approved", when, optionName].filter(Boolean).join(" · ");
}
