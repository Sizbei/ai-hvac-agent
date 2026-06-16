/**
 * Stage 9 — native invoicing + payments + refunds (path B, for non-FSM orgs).
 *
 * Money moves through the PaymentProvider seam (mock until Stripe keys exist).
 * Line items snapshot from the sold estimate option. Refunds/credits are
 * first-class (a half-built payments path breaks on the first chargeback).
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  estimates,
  estimateOptions,
  estimateLineItems,
  invoices,
  invoiceLineItems,
  jobMaterials,
  payments,
  refunds,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { rollUpActualMaterialsCost } from "@/lib/admin/margin";
import { getPaymentProvider, type PaymentProvider } from "@/lib/payments/provider";

export type CreateInvoiceResult =
  | { readonly ok: true; readonly invoiceId: string }
  | { readonly ok: false; readonly reason: "estimate_not_sold" | "no_sold_option" };

/**
 * Materialize an invoice from a SOLD estimate: snapshot the chosen option's line
 * items + totals. Atomic via db.batch.
 */
export async function createInvoiceFromSoldEstimate(
  organizationId: string,
  estimateId: string,
): Promise<CreateInvoiceResult> {
  const [est] = await db
    .select({
      id: estimates.id,
      status: estimates.status,
      soldOptionId: estimates.soldOptionId,
      customerId: estimates.customerId,
      serviceRequestId: estimates.serviceRequestId,
    })
    .from(estimates)
    .where(withTenant(estimates, organizationId, eq(estimates.id, estimateId)))
    .limit(1);

  if (!est || est.status !== "sold") {
    return { ok: false, reason: "estimate_not_sold" };
  }
  if (!est.soldOptionId) {
    return { ok: false, reason: "no_sold_option" };
  }

  // Idempotency: one invoice per estimate. Return the existing one instead of
  // duplicating (paired with the unique index for the concurrent-call race).
  const [existingInvoice] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.estimateId, estimateId)))
    .limit(1);
  if (existingInvoice) {
    return { ok: true, invoiceId: existingInvoice.id };
  }

  const [opt] = await db
    .select({
      subtotalCents: estimateOptions.subtotalCents,
      taxCents: estimateOptions.taxCents,
      totalCents: estimateOptions.totalCents,
    })
    .from(estimateOptions)
    .where(eq(estimateOptions.id, est.soldOptionId))
    .limit(1);
  if (!opt) return { ok: false, reason: "no_sold_option" };

  const lines = await db
    .select({
      name: estimateLineItems.name,
      quantity: estimateLineItems.quantity,
      unitPriceCents: estimateLineItems.unitPriceCents,
      costCents: estimateLineItems.costCents,
      lineTotalCents: estimateLineItems.lineTotalCents,
    })
    .from(estimateLineItems)
    .where(eq(estimateLineItems.optionId, est.soldOptionId));

  const invoiceId = randomUUID();
  const invoiceInsert = db.insert(invoices).values({
    id: invoiceId,
    organizationId,
    serviceRequestId: est.serviceRequestId,
    customerId: est.customerId,
    estimateId: est.id,
    state: "open",
    subtotalCents: opt.subtotalCents,
    taxCents: opt.taxCents,
    totalCents: opt.totalCents,
    amountPaidCents: 0,
  });
  if (lines.length > 0) {
    await db.batch([
      invoiceInsert,
      db.insert(invoiceLineItems).values(
        lines.map((l) => ({ ...l, organizationId, invoiceId })),
      ),
    ]);
  } else {
    await db.batch([invoiceInsert]);
  }

  return { ok: true, invoiceId };
}

export type TakePaymentResult =
  | { readonly ok: true; readonly paymentId: string; readonly invoiceState: string }
  | {
      readonly ok: false;
      readonly reason: "invoice_not_found" | "invoice_not_chargeable" | "charge_failed";
    };

/**
 * Charge an invoice via the payment provider, record the payment, and advance
 * the invoice (paid when fully covered). `pct`-based deposits pass a partial
 * amount. The provider is injectable for tests.
 */
export async function takePayment(
  organizationId: string,
  invoiceId: string,
  params: { readonly amountCents: number; readonly isDeposit?: boolean },
  provider: PaymentProvider = getPaymentProvider(),
): Promise<TakePaymentResult> {
  const [inv] = await db
    .select({
      id: invoices.id,
      state: invoices.state,
      totalCents: invoices.totalCents,
      amountPaidCents: invoices.amountPaidCents,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)))
    .limit(1);
  if (!inv) return { ok: false, reason: "invoice_not_found" };
  // Only an open/draft invoice can be charged — never a paid/void/refunded one
  // (that would over-collect or charge a cancelled invoice).
  if (inv.state !== "open" && inv.state !== "draft") {
    return { ok: false, reason: "invoice_not_chargeable" };
  }

  const paymentId = randomUUID();
  // Record the attempt first (pending) so a provider success is never lost.
  await db.insert(payments).values({
    id: paymentId,
    organizationId,
    invoiceId,
    provider: provider.name,
    amountCents: params.amountCents,
    status: "pending",
    isDeposit: params.isDeposit ?? false,
  });

  const result = await provider.createCharge({
    amountCents: params.amountCents,
    idempotencyKey: paymentId,
    description: `Invoice ${invoiceId}`,
  });

  if (result.status === "failed") {
    await db
      .update(payments)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(payments.id, paymentId));
    return { ok: false, reason: "charge_failed" };
  }

  const newPaid = inv.amountPaidCents + params.amountCents;
  const invoiceState = newPaid >= inv.totalCents ? "paid" : "open";
  await db.batch([
    db
      .update(payments)
      .set({
        status: "succeeded",
        providerPaymentId: result.providerPaymentId,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, paymentId)),
    db
      .update(invoices)
      .set({ amountPaidCents: newPaid, state: invoiceState, updatedAt: new Date() })
      .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId))),
  ]);

  return { ok: true, paymentId, invoiceState };
}

export type RefundResultOut =
  | { readonly ok: true; readonly refundId: string }
  | {
      readonly ok: false;
      readonly reason: "payment_not_found" | "not_refundable" | "exceeds_payment";
    };

/**
 * Refund (full or partial) a succeeded payment via the provider, record the
 * refund, and roll back the invoice's paid amount / state.
 */
export async function refundPayment(
  organizationId: string,
  paymentId: string,
  params: { readonly amountCents: number; readonly reason?: string },
  provider: PaymentProvider = getPaymentProvider(),
): Promise<RefundResultOut> {
  const [pay] = await db
    .select({
      id: payments.id,
      invoiceId: payments.invoiceId,
      amountCents: payments.amountCents,
      status: payments.status,
      providerPaymentId: payments.providerPaymentId,
    })
    .from(payments)
    .where(withTenant(payments, organizationId, eq(payments.id, paymentId)))
    .limit(1);
  if (!pay) return { ok: false, reason: "payment_not_found" };
  // Only a SUCCEEDED charge can be refunded (never pending/failed/already-refunded).
  if (pay.status !== "succeeded") {
    return { ok: false, reason: "not_refundable" };
  }
  // Guard against over-refunding: sum prior refunds, cap at the remaining balance.
  // Tenant-scoped so a payment's refunds can't be summed across orgs.
  const prior = await db
    .select({ amountCents: refunds.amountCents })
    .from(refunds)
    .where(withTenant(refunds, organizationId, eq(refunds.paymentId, paymentId)));
  const alreadyRefunded = prior.reduce((s, r) => s + r.amountCents, 0);
  if (params.amountCents <= 0 || params.amountCents > pay.amountCents - alreadyRefunded) {
    return { ok: false, reason: "exceeds_payment" };
  }
  const fullyRefunded = alreadyRefunded + params.amountCents >= pay.amountCents;

  // Read the invoice (tenant-scoped) BEFORE the provider call: we need to know
  // whether it was fully paid, because a partial refund of a fully-paid invoice
  // must NOT reopen it for charging (that would allow over-collection).
  const [inv] = await db
    .select({ amountPaidCents: invoices.amountPaidCents, totalCents: invoices.totalCents })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, pay.invoiceId)))
    .limit(1);
  const wasFullyPaid = (inv?.amountPaidCents ?? 0) >= (inv?.totalCents ?? 0);
  const newPaid = Math.max(0, (inv?.amountPaidCents ?? 0) - params.amountCents);

  // Stable idempotency key from invariants (payment + cumulative prior refunds +
  // this amount): a RETRY of the same logical refund yields the same key, so the
  // provider dedupes it — preventing a double money-out if the batch below fails
  // after the provider already succeeded.
  const idempotencyKey = `${paymentId}:${alreadyRefunded}:${params.amountCents}`;
  const result = await provider.refund({
    providerPaymentId: pay.providerPaymentId ?? "",
    amountCents: params.amountCents,
    reason: params.reason,
    idempotencyKey,
  });

  const refundId = randomUUID();
  await db.batch([
    db.insert(refunds).values({
      id: refundId,
      organizationId,
      paymentId,
      amountCents: params.amountCents,
      reason: params.reason ?? null,
      providerRefundId: result.providerRefundId,
    }),
    db
      .update(payments)
      // Stay "succeeded" on a PARTIAL refund (more can be refunded up to the
      // balance); only "refunded" once fully refunded — which also blocks any
      // further refund via the status guard above.
      .set({ status: fullyRefunded ? "refunded" : "succeeded", updatedAt: new Date() })
      .where(withTenant(payments, organizationId, eq(payments.id, paymentId))),
    db
      .update(invoices)
      .set({
        amountPaidCents: newPaid,
        // Fully refunded -> "refunded". Partial refund of a fully-paid invoice
        // stays "paid" (NOT chargeable — prevents over-collection). Partial
        // refund of a partially-paid invoice stays "open" (a real balance remains).
        state: newPaid <= 0 ? "refunded" : wasFullyPaid ? "paid" : "open",
        updatedAt: new Date(),
      })
      .where(withTenant(invoices, organizationId, eq(invoices.id, pay.invoiceId))),
  ]);

  return { ok: true, refundId };
}

// ---------------------------------------------------------------------------
// Reconciliation — heal stranded payments.
//
// takePayment records a payment as 'pending', calls the provider, THEN flips it
// to 'succeeded' + advances the invoice in a 2-statement db.batch. On neon-http
// db.batch is SEQUENTIAL, not a transaction: if the provider succeeded but the
// batch failed (or the lambda died), the payment is stranded at 'pending' with
// money possibly moved and no local record of success. Reconciliation re-asks
// the provider for the true charge status (via getCharge, keyed by paymentId)
// and completes or fails the stranded payment idempotently.
// ---------------------------------------------------------------------------

export interface StuckPaymentRow {
  readonly id: string;
  readonly invoiceId: string;
  readonly amountCents: number;
  readonly createdAt: Date;
}

/**
 * Payments stuck at status='pending' older than `olderThanMs` (default 2 min).
 * The age cutoff avoids racing a charge that is legitimately still in flight in
 * takePayment. Tenant-scoped.
 */
export async function listStuckPayments(
  organizationId: string,
  olderThanMs = 120000,
): Promise<StuckPaymentRow[]> {
  const cutoff = new Date(Date.now() - olderThanMs);
  return db
    .select({
      id: payments.id,
      invoiceId: payments.invoiceId,
      amountCents: payments.amountCents,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(
      withTenant(
        payments,
        organizationId,
        eq(payments.status, "pending"),
        lt(payments.createdAt, cutoff),
      ),
    )
    .orderBy(asc(payments.createdAt));
}

export type ReconcileResult =
  | { readonly ok: true; readonly outcome: "completed"; readonly invoiceState: string }
  | { readonly ok: true; readonly outcome: "noop" }
  | { readonly ok: true; readonly outcome: "failed_marked" }
  | { readonly ok: false; readonly reason: "payment_not_found" | "not_pending" };

/**
 * Reconcile a single stranded payment against the provider's true charge status.
 * - succeeded -> complete exactly what takePayment's success path does
 *   (payment->succeeded + recompute invoice amountPaidCents/state via db.batch),
 *   all tenant-scoped. Idempotent: re-reads and only writes while still 'pending'.
 * - failed -> mark the payment failed (no money moved).
 * The provider is injectable for tests.
 */
export async function reconcilePayment(
  organizationId: string,
  paymentId: string,
  provider: PaymentProvider = getPaymentProvider(),
): Promise<ReconcileResult> {
  const [pay] = await db
    .select({
      id: payments.id,
      invoiceId: payments.invoiceId,
      amountCents: payments.amountCents,
      status: payments.status,
    })
    .from(payments)
    .where(withTenant(payments, organizationId, eq(payments.id, paymentId)))
    .limit(1);
  if (!pay) return { ok: false, reason: "payment_not_found" };
  // Idempotency: only a still-'pending' payment can be reconciled. If a concurrent
  // reconcile (or a late-landing original batch) already resolved it, no-op.
  if (pay.status !== "pending") return { ok: false, reason: "not_pending" };

  // takePayment used paymentId as the createCharge idempotencyKey.
  const charge = await provider.getCharge(paymentId);

  if (charge.status === "failed") {
    await db
      .update(payments)
      .set({ status: "failed", updatedAt: new Date() })
      .where(withTenant(payments, organizationId, eq(payments.id, paymentId)));
    return { ok: true, outcome: "failed_marked" };
  }

  // Provider still 'pending' on its side: leave it for a later sweep rather than
  // guessing. (The mock never returns this; a real adapter might mid-auth.)
  if (charge.status !== "succeeded") {
    return { ok: true, outcome: "noop" };
  }

  // Re-read the invoice (tenant-scoped) to recompute paid amount/state the same
  // way takePayment's success path does.
  const [inv] = await db
    .select({
      totalCents: invoices.totalCents,
      amountPaidCents: invoices.amountPaidCents,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, pay.invoiceId)))
    .limit(1);
  if (!inv) {
    // Invoice vanished (e.g. cascade-deleted): mark the orphan charge succeeded so
    // it stops being "stuck", but don't fabricate an invoice update.
    await db
      .update(payments)
      .set({
        status: "succeeded",
        providerPaymentId: charge.providerPaymentId,
        updatedAt: new Date(),
      })
      .where(withTenant(payments, organizationId, eq(payments.id, paymentId)));
    return { ok: true, outcome: "completed", invoiceState: "unknown" };
  }

  const newPaid = inv.amountPaidCents + pay.amountCents;
  const invoiceState = newPaid >= inv.totalCents ? "paid" : "open";
  await db.batch([
    db
      .update(payments)
      .set({
        status: "succeeded",
        providerPaymentId: charge.providerPaymentId,
        updatedAt: new Date(),
      })
      .where(withTenant(payments, organizationId, eq(payments.id, paymentId))),
    db
      .update(invoices)
      .set({ amountPaidCents: newPaid, state: invoiceState, updatedAt: new Date() })
      .where(withTenant(invoices, organizationId, eq(invoices.id, pay.invoiceId))),
  ]);

  return { ok: true, outcome: "completed", invoiceState };
}

export interface ReconcileSweepSummary {
  readonly scanned: number;
  readonly completed: number;
  readonly failed: number;
  readonly noop: number;
}

/**
 * Sweep an org's stuck payments and reconcile each. Returns a count summary.
 * Per-payment errors are swallowed (counted as noop) so one bad row doesn't
 * abort the sweep.
 */
export async function reconcileOrgPendingPayments(
  organizationId: string,
  provider: PaymentProvider = getPaymentProvider(),
): Promise<ReconcileSweepSummary> {
  const stuck = await listStuckPayments(organizationId);
  let completed = 0;
  let failed = 0;
  let noop = 0;
  for (const p of stuck) {
    try {
      const r = await reconcilePayment(organizationId, p.id, provider);
      if (r.ok && r.outcome === "completed") completed++;
      else if (r.ok && r.outcome === "failed_marked") failed++;
      else noop++;
    } catch {
      noop++;
    }
  }
  return { scanned: stuck.length, completed, failed, noop };
}

// ---------------------------------------------------------------------------
// Read queries for the admin UI (list + detail). No behavior change to the
// mutations above — these are tenant-scoped reads only.
// ---------------------------------------------------------------------------

export interface InvoiceListRow {
  readonly id: string;
  readonly state: string;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly customerId: string | null;
  readonly serviceRequestId: string | null;
  readonly createdAt: Date;
}

/** Admin list of an org's invoices, newest first. */
export async function listInvoices(
  organizationId: string,
): Promise<InvoiceListRow[]> {
  return db
    .select({
      id: invoices.id,
      state: invoices.state,
      totalCents: invoices.totalCents,
      amountPaidCents: invoices.amountPaidCents,
      customerId: invoices.customerId,
      serviceRequestId: invoices.serviceRequestId,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId))
    .orderBy(desc(invoices.createdAt));
}

export interface InvoiceLineItemView {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  /** Snapshotted cost (ADMIN-ONLY — invoices are not customer-facing here). */
  readonly costCents: number;
  readonly lineTotalCents: number;
}

export interface RefundView {
  readonly id: string;
  readonly amountCents: number;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface PaymentView {
  readonly id: string;
  readonly amountCents: number;
  readonly status: string;
  readonly isDeposit: boolean;
  readonly createdAt: Date;
  readonly refunds: RefundView[];
}

export interface InvoiceDetailView {
  readonly id: string;
  readonly state: string;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly customerId: string | null;
  readonly serviceRequestId: string | null;
  readonly estimateId: string | null;
  readonly createdAt: Date;
  readonly lineItems: InvoiceLineItemView[];
  readonly payments: PaymentView[];
  /**
   * ACTUAL materials cost (cents) the tech recorded on the linked service
   * request, if any. NULL when the invoice has no linked job or no field
   * materials were recorded. Distinct from the estimated line-snapshot cost —
   * shown alongside it, never replacing it. ADMIN-ONLY (sensitive cost data).
   */
  readonly actualMaterialsCostCents: number | null;
}

/**
 * Detail view: invoice header + its line items + its payments (each with that
 * payment's refunds). All reads tenant-scoped. Returns null if not found.
 */
export async function getInvoiceDetailById(
  organizationId: string,
  id: string,
): Promise<InvoiceDetailView | null> {
  const [inv] = await db
    .select({
      id: invoices.id,
      state: invoices.state,
      subtotalCents: invoices.subtotalCents,
      taxCents: invoices.taxCents,
      totalCents: invoices.totalCents,
      amountPaidCents: invoices.amountPaidCents,
      customerId: invoices.customerId,
      serviceRequestId: invoices.serviceRequestId,
      estimateId: invoices.estimateId,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, id)))
    .limit(1);

  if (!inv) return null;

  const lineItems = await db
    .select({
      id: invoiceLineItems.id,
      name: invoiceLineItems.name,
      quantity: invoiceLineItems.quantity,
      unitPriceCents: invoiceLineItems.unitPriceCents,
      costCents: invoiceLineItems.costCents,
      lineTotalCents: invoiceLineItems.lineTotalCents,
    })
    .from(invoiceLineItems)
    .where(
      withTenant(
        invoiceLineItems,
        organizationId,
        eq(invoiceLineItems.invoiceId, id),
      ),
    )
    .orderBy(asc(invoiceLineItems.id));

  const paymentRows = await db
    .select({
      id: payments.id,
      amountCents: payments.amountCents,
      status: payments.status,
      isDeposit: payments.isDeposit,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(withTenant(payments, organizationId, eq(payments.invoiceId, id)))
    .orderBy(desc(payments.createdAt));

  // Attach each payment's refunds. Fetch them all in one tenant-scoped query,
  // then bucket by paymentId (avoids an N+1 over the payments).
  const paymentIds = paymentRows.map((p) => p.id);
  const refundRows =
    paymentIds.length > 0
      ? await db
          .select({
            id: refunds.id,
            paymentId: refunds.paymentId,
            amountCents: refunds.amountCents,
            reason: refunds.reason,
            createdAt: refunds.createdAt,
          })
          .from(refunds)
          .where(
            withTenant(
              refunds,
              organizationId,
              inArray(refunds.paymentId, paymentIds),
            ),
          )
          .orderBy(desc(refunds.createdAt))
      : [];

  const refundsByPayment = new Map<string, RefundView[]>();
  for (const r of refundRows) {
    const view: RefundView = {
      id: r.id,
      amountCents: r.amountCents,
      reason: r.reason,
      createdAt: r.createdAt,
    };
    const bucket = refundsByPayment.get(r.paymentId);
    if (bucket) bucket.push(view);
    else refundsByPayment.set(r.paymentId, [view]);
  }

  // Actual field-materials cost, rolled up from the materials the tech recorded
  // on the linked service request. NULL when there's no linked job or no
  // materials — so the UI can present "actual" only when it exists, alongside
  // (never overwriting) the estimated line-snapshot cost.
  let actualMaterialsCostCents: number | null = null;
  if (inv.serviceRequestId) {
    const materialRows = await db
      .select({
        quantity: jobMaterials.quantity,
        unitCostCents: jobMaterials.unitCostCents,
      })
      .from(jobMaterials)
      .where(
        withTenant(
          jobMaterials,
          organizationId,
          eq(jobMaterials.serviceRequestId, inv.serviceRequestId),
        ),
      );
    actualMaterialsCostCents =
      materialRows.length > 0 ? rollUpActualMaterialsCost(materialRows) : null;
  }

  return {
    ...inv,
    lineItems,
    payments: paymentRows.map((p) => ({
      ...p,
      refunds: refundsByPayment.get(p.id) ?? [],
    })),
    actualMaterialsCostCents,
  };
}
