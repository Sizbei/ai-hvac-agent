/**
 * Pure lock and stale-intent rules for the S40 field invoice page (spec §7).
 * Tests run in node.
 */
import { approvalBlocked, type UnknownBanner } from "./approval-flow";
import type { TechInvoiceView } from "./invoice-view";
import { fullInvoice, type IntentKind } from "./invoice-view-diff";

/**
 * Unknown intents a refetch has made moot: a signature once the request's
 * signature is fresh or the invoice left draft, a finalize once it left draft.
 * Payments and lines are dropped only through `intentLanded` (not here).
 */
export function staleUnknownKinds(view: TechInvoiceView, unknownKinds: readonly IntentKind[]): IntentKind[] {
  const state = view.invoice?.state;
  const fresh = fullInvoice(view)?.signature.fresh === true;
  return unknownKinds.filter((k) => {
    if (k === "signature") return fresh || state !== "draft";
    if (k === "finalize") return state !== "draft";
    return false;
  });
}

export interface PageLockInput {
  readonly pendingWrite: boolean;
  readonly busy: IntentKind | null;
  readonly recovering: boolean;
  readonly unknownKinds: readonly IntentKind[];
}

export interface PageLocks {
  /** Every edit and collect action waits. */
  readonly locked: boolean;
  /** The add-item sheet re-sends its own unknown add ("Try again"); only OTHER intents lock it. */
  readonly addLocked: boolean;
  /** "Customer approval" waits while the server holds a write or a non-approval intent is unknown. */
  readonly approvalBlocked: boolean;
}

export function pageLocks(i: PageLockInput): PageLocks {
  return {
    locked: i.pendingWrite || i.recovering || i.busy !== null || i.unknownKinds.length > 0,
    addLocked:
      i.pendingWrite ||
      i.recovering ||
      (i.busy !== null && i.busy !== "add_line") ||
      i.unknownKinds.some((k) => k !== "add_line"),
    approvalBlocked: i.pendingWrite || approvalBlocked(i.unknownKinds),
  };
}

/** Whether the "Customer approval" sheet can mount (lead, draft with lines, sign or finalize allowed). */
export function approvalCanMount(view: TechInvoiceView): boolean {
  const inv = fullInvoice(view);
  if (!view.isLead || !inv || inv.state !== "draft" || inv.lines.length === 0) return false;
  return view.allowed.includes("finalize") || view.allowed.includes("sign");
}

export const APPROVAL_CLOSED = "This invoice is no longer a draft, so there is nothing to approve.";

export type BannerTap =
  | { readonly type: "open_approval" }
  | { readonly type: "retry"; readonly kind: IntentKind }
  | { readonly type: "status"; readonly text: string };

/** What the "may not have saved" banner's button does; never opens a sheet that cannot mount. */
export function bannerTap(banner: UnknownBanner, view: TechInvoiceView): BannerTap {
  if (banner.action === "retry") return { type: "retry", kind: banner.kind };
  return approvalCanMount(view) ? { type: "open_approval" } : { type: "status", text: APPROVAL_CLOSED };
}

/**
 * The payment body the record sheet shows read-only: while a send is in flight
 * or the payment intent is unknown, the last sent body (or, after a reload,
 * the stored one); otherwise null (the form is editable).
 */
export function inFlightPaymentBody<T>(
  state: { readonly busy: boolean; readonly paymentUnknown: boolean; readonly stored: T | null },
  lastBody: T | null,
): T | null {
  if (!state.busy && !state.paymentUnknown) return null;
  return lastBody ?? (state.paymentUnknown ? state.stored : null);
}
