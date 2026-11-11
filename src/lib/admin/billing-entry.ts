/**
 * What every billing entry point (Settings card, Staff "See plans", seat-limit
 * messages) says for the viewer. Driven by the same `billingPageView` result as
 * /admin/settings/billing, so a platform-managed org is told who handles
 * billing and is never told to upgrade. Pure; client-safe.
 */
import type { BillingPageView } from "./preview-view";
import { HISTORY_CONTACT_FALLBACK } from "./admin-guide-state";

export interface BillingEntry {
  readonly view: BillingPageView;
  /** Who handles billing; set when `view` is "handled". */
  readonly contact: string | null;
}

/** Before the layout has decided (or without billing access): no link, no upgrade. */
export const NO_BILLING_ENTRY: BillingEntry = Object.freeze({ view: "redirect", contact: null });

export function showsBillingLink(entry: BillingEntry): boolean {
  return entry.view === "panel";
}

export function billingHandledCopy(entry: BillingEntry): string {
  return `Billing is handled by ${entry.contact ?? HISTORY_CONTACT_FALLBACK}.`;
}

function seatNextStep(entry: BillingEntry): string {
  if (entry.view === "panel") return "Deactivate someone or upgrade the plan to add more.";
  if (entry.view === "handled") return `Deactivate someone to add more. ${billingHandledCopy(entry)}`;
  return "Deactivate someone to add more.";
}

/** The Staff page notice when the plan is full. */
export function seatLimitNotice(entry: BillingEntry): string {
  return `Your plan has no free seats, so you can’t add or invite anyone right now. ${seatNextStep(entry)}`;
}

/** A refused add, invite or reactivation (SEAT_LIMIT_REACHED). */
export function seatLimitError(entry: BillingEntry): string {
  return `Your plan has no free seats. ${seatNextStep(entry)}`;
}
