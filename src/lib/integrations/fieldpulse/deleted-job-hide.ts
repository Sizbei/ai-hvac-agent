/**
 * Hide requests whose FieldPulse job was deleted in FieldPulse (GET /jobs/{id}
 * returns 404). The rows were imported while the job existed; the job is gone,
 * so in the org's view they look like live requests that no one is working.
 * PURE: the backfill script (scripts/agent/fp-truth-backfill.mts) fetches the
 * rows and FieldPulse answers, this decides what to hide. Nothing is deleted.
 *
 * Rules:
 * - a request is hidden only when EVERY invoice and estimate attached to it
 *   is FieldPulse-less (not synced from FieldPulse or Housecall Pro) and has
 *   no money paid. Those children are clearly orphaned with it and are hidden
 *   too. Anything synced or paid keeps the request (and itself) visible, and
 *   the request is listed for review instead.
 * - a row already hidden is left out of the plan, so the undo list holds only
 *   rows this run hid and an undo never un-hides someone else's hide.
 */

export interface DeletedJobRequest {
  readonly id: string;
  readonly referenceNumber: string;
  readonly status: string;
  readonly title: string;
  readonly hidden: boolean;
}

export interface DeletedJobChild {
  readonly kind: "invoice" | "estimate";
  readonly id: string;
  readonly requestId: string;
  /** Synced from FieldPulse or Housecall Pro. */
  readonly synced: boolean;
  /** Money paid on it, any provider. */
  readonly paidCents: number;
  readonly hidden: boolean;
}

export interface DeletedJobHidePlan {
  readonly requests: readonly DeletedJobRequest[];
  readonly children: readonly DeletedJobChild[];
  readonly kept: readonly { readonly request: DeletedJobRequest; readonly reason: string }[];
}

/** Plan the hide for requests already known to be deleted in FieldPulse. */
export function planDeletedJobHide(
  deletedRequests: readonly DeletedJobRequest[],
  children: readonly DeletedJobChild[],
): DeletedJobHidePlan {
  const byRequest = new Map<string, DeletedJobChild[]>();
  for (const c of children) {
    const list = byRequest.get(c.requestId) ?? [];
    list.push(c);
    byRequest.set(c.requestId, list);
  }

  const requests: DeletedJobRequest[] = [];
  const hideChildren: DeletedJobChild[] = [];
  const kept: { request: DeletedJobRequest; reason: string }[] = [];

  for (const req of deletedRequests) {
    const own = byRequest.get(req.id) ?? [];
    const paid = own.filter((c) => c.paidCents > 0);
    const synced = own.filter((c) => c.synced);
    if (paid.length > 0) {
      kept.push({ request: req, reason: `money paid on ${paid.length} ${paid.length === 1 ? "item" : "items"}` });
      continue;
    }
    if (synced.length > 0) {
      kept.push({ request: req, reason: `${synced.length} synced ${synced.length === 1 ? "invoice or estimate" : "invoices or estimates"}` });
      continue;
    }
    if (!req.hidden) requests.push(req);
    hideChildren.push(...own.filter((c) => !c.hidden));
  }

  return { requests, children: hideChildren, kept };
}

/** One line for the dry-run list: reference, status, title cut to `max`. */
export function describeDeletedJobRequest(req: DeletedJobRequest, max = 48): string {
  const title = req.title.replace(/\s+/g, " ").trim();
  const cut = title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
  return `${req.referenceNumber}  ${req.status.padEnd(11)}  ${cut}`;
}

// ── Invoices deleted in FieldPulse (fp-hide-deleted-jobs.mts --invoices) ──────

export interface DeletedInvoice {
  readonly id: string;
  readonly fieldpulseInvoiceId: string;
  readonly balanceCents: number;
  /** amount_paid_cents on the row. */
  readonly amountPaidCents: number;
  /** Any payments row recorded against it. */
  readonly hasPaymentRow: boolean;
  readonly hidden: boolean;
}

export interface DeletedInvoiceHidePlan {
  readonly hide: readonly DeletedInvoice[];
  readonly kept: readonly { readonly invoice: DeletedInvoice; readonly reason: string }[];
}

/**
 * Plan the hide for mirrored invoices FieldPulse no longer has (GET
 * /invoices/{id} → 404). Only the invoice is hidden; its request and customer
 * are left alone. Anything with a recorded payment is never hidden: that
 * money happened, so a person must look. Rows already hidden are left out.
 */
export function planDeletedInvoiceHide(deleted: readonly DeletedInvoice[]): DeletedInvoiceHidePlan {
  const hide: DeletedInvoice[] = [];
  const kept: { invoice: DeletedInvoice; reason: string }[] = [];
  for (const inv of deleted) {
    if (inv.hidden) continue;
    if (inv.amountPaidCents > 0 || inv.hasPaymentRow) {
      kept.push({ invoice: inv, reason: "has a recorded payment" });
      continue;
    }
    hide.push(inv);
  }
  return { hide, kept };
}
