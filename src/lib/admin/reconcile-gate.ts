/**
 * When the invoices page's stuck-payment check (`GET /api/admin/payments/reconcile`)
 * may run. It is a best-effort banner, so it waits until the first invoice rows
 * have settled (loaded or failed) instead of competing with them, and runs once
 * per visit: filter refetches don't re-poll it.
 */
export function reconcileShouldRun(input: {
  readonly firstPaintDone: boolean;
  readonly alreadyRan: boolean;
}): boolean {
  return input.firstPaintDone && !input.alreadyRan;
}
