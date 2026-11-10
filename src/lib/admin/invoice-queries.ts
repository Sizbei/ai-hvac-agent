/**
 * Stage 9 — native invoicing + payments + refunds (path B, for non-FSM orgs).
 *
 * Money moves through the PaymentProvider seam (mock until Stripe keys exist).
 * Line items snapshot from the sold estimate option. Refunds/credits are
 * first-class (a half-built payments path breaks on the first chargeback).
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql, sum, type SQL } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { db } from "@/lib/db";
import {
  communicationJobs,
  customers,
  estimates,
  estimateOptions,
  estimateLineItems,
  invoices,
  invoiceLineItems,
  jobMaterials,
  organizationSettings,
  payments,
  refunds,
  serviceRequests,
  technicianTimeEntries,
  users,
} from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";
import { withTenant } from "@/lib/db/tenant";
import { visibleRows, type Visibility } from "@/lib/admin/visibility";
import {
  rollUpActualMaterialsCost,
  rollUpActualLaborCost,
} from "@/lib/admin/margin";
import { getPaymentProvider, type PaymentProvider } from "@/lib/payments/provider";
import { cardPaymentsEnabled } from "@/lib/payments/card-enabled";
import { businessInfoSchema } from "@/lib/admin/org-config-types";
import { invoiceRef } from "@/lib/admin/invoice-collectible";
import { billingInvoiceIdSql, eidParam, jobBilledSql } from "@/lib/admin/estimate-billing-sql";

/**
 * Canonical SQL overdue predicate for a single open invoice row.
 * Canonical definition (SummaryBand / collections workspace):
 *   - Has a due date  → overdue when past due by more than 1 day (grace period).
 *   - No due date     → overdue when issued/created >= 30 days ago.
 * Use this in all AR surfaces so "overdue" means the same thing everywhere.
 */
export function overdueWhere(tbl: typeof invoices): SQL<unknown> {
  return sql`(
    (${tbl.dueDate} is not null and ${tbl.dueDate} < now() - interval '1 day')
    or (${tbl.dueDate} is null and coalesce(${tbl.issuedAt}, ${tbl.createdAt}) <= now() - interval '30 days')
  )`;
}

export type CreateInvoiceResult =
  | {
      readonly ok: true;
      readonly invoiceId: string;
      /** False when the estimate already had its invoice (idempotent return). */
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "estimate_not_sold" | "no_sold_option" | "synced_read_only" | "request_has_draft";
    };

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
      fieldpulseEstimateId: estimates.fieldpulseEstimateId,
    })
    .from(estimates)
    .where(withTenant(estimates, organizationId, eq(estimates.id, estimateId)))
    .limit(1);

  if (!est || est.status !== "sold") {
    return { ok: false, reason: "estimate_not_sold" };
  }
  if (est.fieldpulseEstimateId != null) {
    return { ok: false, reason: "synced_read_only" };
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
    return { ok: true, invoiceId: existingInvoice.id, created: false };
  }

  const [opt] = await db
    .select({
      subtotalCents: estimateOptions.subtotalCents,
      taxCents: estimateOptions.taxCents,
      totalCents: estimateOptions.totalCents,
    })
    .from(estimateOptions)
    .where(
      withTenant(
        estimateOptions,
        organizationId,
        eq(estimateOptions.id, est.soldOptionId),
      ),
    )
    .limit(1);
  if (!opt) return { ok: false, reason: "no_sold_option" };

  const lines = await db
    .select({
      id: estimateLineItems.id,
      name: estimateLineItems.name,
      quantity: estimateLineItems.quantity,
      unitPriceCents: estimateLineItems.unitPriceCents,
      costCents: estimateLineItems.costCents,
      lineTotalCents: estimateLineItems.lineTotalCents,
    })
    .from(estimateLineItems)
    .where(withTenant(estimateLineItems, organizationId, eq(estimateLineItems.optionId, est.soldOptionId)))
    .orderBy(asc(estimateLineItems.id));

  const invoiceId = randomUUID();
  if (est.serviceRequestId) {
    return createRequestEstimateInvoice(organizationId, est.serviceRequestId, invoiceId, est, opt, lines);
  }
  const invoiceInsert = db.insert(invoices).values({
    id: invoiceId,
    organizationId,
    serviceRequestId: est.serviceRequestId,
    customerId: est.customerId,
    estimateId: est.id,
    state: "open", // born open: billed(eid)'s job half relies on it (estimate-billing-sql.ts jobLinesFrom)
    subtotalCents: opt.subtotalCents,
    taxCents: opt.taxCents,
    totalCents: opt.totalCents,
    amountPaidCents: 0,
  });
  if (lines.length > 0) {
    await db.batch([
      invoiceInsert,
      db.insert(invoiceLineItems).values(
        lines.map(({ id, ...l }) => ({ ...l, id: uuidv7(), estimateLineItemId: id, organizationId, invoiceId })),
      ),
    ]);
  } else {
    await db.batch([invoiceInsert]);
  }

  return { ok: true, invoiceId, created: true };
}

type EstimateLine = { id: string; name: string; quantity: number; unitPriceCents: number; costCents: number; lineTotalCents: number };

/**
 * Estimate-born invoice on a request (M3b spec §5.8, M3c spec §5.4): ONE batch
 * — L_req, then the INSERT refuses while the request has a NATIVE draft or the
 * job's invoice already holds this estimate's lines (the job half of
 * billed(eid)); the lines land only when this transaction wrote the invoice
 * (xmin gate), linked to their estimate line, v7 ids in line order.
 */
async function createRequestEstimateInvoice(
  org: string,
  rid: string,
  inv: string,
  est: { id: string; customerId: string | null },
  opt: { subtotalCents: number; taxCents: number; totalCents: number },
  lines: readonly EstimateLine[],
): Promise<CreateInvoiceResult> {
  // Lazy: the M3b writer module's import graph (tech field queries, inventory,
  // status writes) stays off this widely-imported module's load path.
  const { lockRequestSql, P_NATIVE } = await import("./invoice-field-writes");
  // Born 'open', never 'draft': billed(eid)'s job half relies on it (estimate-billing-sql.ts jobLinesFrom).
  const items: SQL[] = [
    lockRequestSql(org, rid),
    sql`INSERT INTO invoices (id, organization_id, service_request_id, customer_id, estimate_id, state, subtotal_cents, tax_cents, total_cents, amount_paid_cents)
      SELECT ${inv}::uuid, ${org}::uuid, ${rid}::uuid, ${est.customerId}::uuid, ${est.id}::uuid, 'open'::invoice_state,
        ${opt.subtotalCents}::int, ${opt.taxCents}::int, ${opt.totalCents}::int, 0
      WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
        AND state = 'draft'::invoice_state AND ${P_NATIVE})
        AND NOT ${jobBilledSql(org, eidParam(est.id))}
      ON CONFLICT DO NOTHING RETURNING id`,
  ];
  if (lines.length > 0) {
    const values = sql.join(
      lines.map(
        (l) =>
          sql`(${uuidv7()}::uuid, ${l.id}::uuid, ${l.name}::text, ${l.quantity}::int, ${l.unitPriceCents}::int, ${l.costCents}::int, ${l.lineTotalCents}::int)`,
      ),
      sql`, `,
    );
    items.push(sql`INSERT INTO invoice_line_items (id, organization_id, invoice_id, estimate_line_item_id, name, quantity, unit_price_cents, cost_cents, line_total_cents)
      SELECT v.id, ${org}::uuid, ${inv}::uuid, v.eli, v.name, v.quantity, v.unit_price_cents, v.cost_cents, v.line_total_cents
      FROM (VALUES ${values}) AS v(id, eli, name, quantity, unit_price_cents, cost_cents, line_total_cents)
      WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ${inv}::uuid AND organization_id = ${org}::uuid AND xmin = pg_current_xact_id()::xid)`);
  }
  const out = (await db.batch(items.map((q) => db.execute(q)) as never)) as unknown as { rows: unknown[] }[];
  if (out[1]!.rows.length > 0) return { ok: true, invoiceId: inv, created: true };
  // No row: a concurrent create of THIS estimate won the per-estimate unique
  // index (return it, like the early return) …
  const [raced] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(withTenant(invoices, org, eq(invoices.estimateId, est.id)))
    .limit(1);
  if (raced) return { ok: true, invoiceId: raced.id, created: false };
  // … or the job's invoice already holds this estimate's lines: that invoice bills it …
  const [job] = await db
    .select({ invoiceId: sql<string | null>`${billingInvoiceIdSql(org, eidParam(est.id))}` })
    .from(estimates)
    .where(withTenant(estimates, org, eq(estimates.id, est.id)))
    .limit(1);
  if (job?.invoiceId) return { ok: true, invoiceId: job.invoiceId, created: false };
  // … or the request has a native draft.
  return { ok: false, reason: "request_has_draft" };
}

export type TakePaymentResult =
  | { readonly ok: true; readonly paymentId: string; readonly invoiceState: string }
  | {
      readonly ok: false;
      readonly reason:
        | "invoice_not_found"
        | "invoice_not_chargeable"
        | "exceeds_balance"
        | "charge_failed"
        | "synced_read_only";
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
      fieldpulseInvoiceId: invoices.fieldpulseInvoiceId,
      hcpInvoiceId: invoices.hcpInvoiceId,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)))
    .limit(1);
  if (!inv) return { ok: false, reason: "invoice_not_found" };
  // Read-only mirror: an FSM-synced invoice (FieldPulse OR Housecall Pro) is
  // billed/paid IN the FSM. Taking a native payment here would double-charge.
  if (inv.fieldpulseInvoiceId || inv.hcpInvoiceId) {
    return { ok: false, reason: "synced_read_only" };
  }
  // Only an open/draft invoice can be charged — never a paid/void/refunded one
  // (that would over-collect or charge a cancelled invoice).
  if (inv.state !== "open" && inv.state !== "draft") {
    return { ok: false, reason: "invoice_not_chargeable" };
  }
  // Over-collection FAST-FAIL (read-based): cheap rejection of the obvious /
  // non-racy case so we never even build a payment for an oversized amount.
  const remainingCents = inv.totalCents - inv.amountPaidCents;
  if (params.amountCents <= 0 || params.amountCents > remainingCents) {
    return { ok: false, reason: "exceeds_balance" };
  }

  // ATOMIC CLAIM before charging — the authoritative over-collection guard under
  // concurrency. A single conditional write reserves the balance: the predicate
  // `amountPaidCents + amount <= totalCents` makes the check and the credit ONE
  // operation, so two concurrent charges (a double-submitted pay form; neon-http
  // has no row locks) can't both pass — the loser matches 0 rows and never hits
  // the card. Only after the reserve succeeds do we charge; a failed charge
  // un-claims (decrements) below. This is the exact fix for the double-charge:
  // the prior read-then-write guard let both racers through.
  const claim = await db
    .update(invoices)
    .set({
      amountPaidCents: sql`${invoices.amountPaidCents} + ${params.amountCents}`,
      updatedAt: new Date(),
    })
    .where(
      withTenant(
        invoices,
        organizationId,
        and(
          eq(invoices.id, invoiceId),
          inArray(invoices.state, ["open", "draft"]),
          sql`${invoices.amountPaidCents} + ${params.amountCents} <= ${invoices.totalCents}`,
        )!,
      ),
    )
    .returning({
      id: invoices.id,
      amountPaidCents: invoices.amountPaidCents,
      totalCents: invoices.totalCents,
    });
  const claimedInvoice = claim[0];
  if (!claimedInvoice) {
    // Lost the race / state changed — the balance was already reserved by a
    // concurrent charge. Do NOT touch the card.
    return { ok: false, reason: "exceeds_balance" };
  }

  // Best-effort state hint (the money figure is exact in the DB; state is only
  // a display hint) — derived from the claim's own RETURNING row, i.e. the
  // ACTUAL post-claim amountPaidCents, never the pre-claim `inv` read taken
  // before the atomic claim. Mirrors reconcilePayment, which also re-derives
  // its state hint from a fresh read rather than a value captured earlier.
  // Two concurrent partial payments that together exactly fill the balance
  // would otherwise each compute their state off their own stale pre-claim
  // snapshot (both see amountPaidCents from before either claim landed) and
  // both write 'open' — permanently stranding a fully-paid invoice in the
  // collections queue even though amountPaidCents is exactly right.
  const invoiceState =
    claimedInvoice.amountPaidCents >= claimedInvoice.totalCents ? "paid" : "open";

  const paymentId = randomUUID();
  let result;
  try {
    await db.insert(payments).values({
      id: paymentId,
      organizationId,
      invoiceId,
      provider: provider.name,
      amountCents: params.amountCents,
      status: "pending",
      isDeposit: params.isDeposit ?? false,
    });

    result = await provider.createCharge({
      amountCents: params.amountCents,
      idempotencyKey: paymentId,
      description: `Invoice ${invoiceId}`,
    });
  } catch (err) {
    // The claim ALREADY credited the invoice. If the payment insert throws there
    // is no pending row for reconciliation to ever find (unhealable over-credit);
    // if createCharge throws the outcome is unknown. Either way, un-claim
    // (decrement) so the invoice can't be permanently over-credited, and best-
    // effort fail the payment row if it was inserted. The idempotency key guards
    // a double-charge if the charge did land and is retried.
    await db
      .update(invoices)
      .set({
        // Don't touch state on un-claim: the invoice was open/draft before the
        // claim (the claim never changed state), so decrementing back leaves it
        // correct. Forcing 'open' promoted a 'draft' invoice.
        amountPaidCents: sql`${invoices.amountPaidCents} - ${params.amountCents}`,
        updatedAt: new Date(),
      })
      .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)))
      .catch(() => {});
    await db
      .update(payments)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(payments.id, paymentId))
      .catch(() => {});
    throw err;
  }

  if (result.status === "failed") {
    // UN-CLAIM: the charge never went through, so release the reserved balance
    // (decrement off the CURRENT row) and mark the payment failed.
    await db.batch([
      db
        .update(payments)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(payments.id, paymentId)),
      db
        .update(invoices)
        .set({
          // Leave state as-is (open/draft) — see the throw-path un-claim above.
          amountPaidCents: sql`${invoices.amountPaidCents} - ${params.amountCents}`,
          updatedAt: new Date(),
        })
        .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId))),
    ]);
    return { ok: false, reason: "charge_failed" };
  }

  // Success: the invoice is already credited (the claim). Finalize the payment
  // and set the display state. Batched so it's one round-trip.
  //
  // The state is derived IN SQL from the row's own columns at write time, not
  // from the value computed back at claim time. Deriving it in JS is not
  // enough: `provider.createCharge` above is an async network call, so two
  // concurrent partial payments can resolve out of claim-order and the loser
  // would overwrite 'paid' back to 'open' with its older snapshot — stranding
  // a fully-paid invoice in the collections queue. Postgres evaluating the
  // comparison during the UPDATE closes that window entirely.
  const [, stateRows] = await db.batch([
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
      .set({
        // ::invoice_state — a bare CASE resolves its branches to text, and
        // Postgres refuses text → enum in an UPDATE assignment (42804), which
        // left every native payment stranded 'pending' with the invoice 'open'.
        state: sql`(case when ${invoices.amountPaidCents} >= ${invoices.totalCents} then 'paid' else 'open' end)::invoice_state`,
        updatedAt: new Date(),
      })
      .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)))
      .returning({ state: invoices.state }),
  ]);

  // Report what was actually written, falling back to the claim-time
  // derivation only if the RETURNING row is somehow absent.
  return { ok: true, paymentId, invoiceState: stateRows?.[0]?.state ?? invoiceState };
}

export type RefundResultOut =
  | { readonly ok: true; readonly refundId: string; readonly created: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | "payment_not_found"
        | "not_refundable"
        | "exceeds_payment"
        | "synced_read_only"
        | "invalid_input"
        | "refund_id_conflict"
        | "stale";
    };

/**
 * Refund (full or partial) a succeeded payment via the provider, record the
 * refund, and roll back the invoice's paid amount / state. A MANUAL payment
 * (cash/check/other) is "undo the recording": it delegates to
 * `refundManualPayment` (one batch, replayable by `refundId`; spec §5.6).
 */
export async function refundPayment(
  organizationId: string,
  paymentId: string,
  params: { readonly amountCents: number; readonly reason?: string; readonly refundId?: string },
  provider: PaymentProvider = getPaymentProvider(),
): Promise<RefundResultOut> {
  const [pay] = await db
    .select({
      id: payments.id,
      invoiceId: payments.invoiceId,
      amountCents: payments.amountCents,
      amountRefundedCents: payments.amountRefundedCents,
      status: payments.status,
      providerPaymentId: payments.providerPaymentId,
      provider: payments.provider,
    })
    .from(payments)
    .where(withTenant(payments, organizationId, eq(payments.id, paymentId)))
    .limit(1);
  if (!pay) return { ok: false, reason: "payment_not_found" };
  // Amount guard BEFORE either path: a non-positive or fractional amount never
  // reaches the manual writer or the provider.
  if (!Number.isInteger(params.amountCents) || params.amountCents < 1) {
    return { ok: false, reason: "exceeds_payment" };
  }
  if (pay.provider === "manual") {
    if (!params.refundId) return { ok: false, reason: "invalid_input" };
    const { refundManualPayment } = await import("./invoice-payment-writes"); // lazy, see createRequestEstimateInvoice
    return refundManualPayment(organizationId, paymentId, { refundId: params.refundId }, {
      amountCents: params.amountCents,
      reason: params.reason,
    });
  }
  // Only a SUCCEEDED charge can be refunded (never pending/failed/already-refunded).
  if (pay.status !== "succeeded") {
    return { ok: false, reason: "not_refundable" };
  }
  const alreadyRefunded = pay.amountRefundedCents;
  // Over-refund FAST-FAIL (read-based; cheap). The atomic CLAIM below is the
  // authoritative guard under concurrency — the prior SUM(refunds)-then-refund
  // path let two concurrent distinct-amount refunds both pass and over-refund.
  if (params.amountCents <= 0 || params.amountCents > pay.amountCents - alreadyRefunded) {
    return { ok: false, reason: "exceeds_payment" };
  }
  const fullyRefunded = alreadyRefunded + params.amountCents >= pay.amountCents;

  // Read the invoice (tenant-scoped) BEFORE the provider call for the synced
  // guard. (The paid/open/refunded state is computed in SQL at write time.)
  const [inv] = await db
    .select({
      fieldpulseInvoiceId: invoices.fieldpulseInvoiceId,
      hcpInvoiceId: invoices.hcpInvoiceId,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, pay.invoiceId)))
    .limit(1);
  // Read-only mirror: refunds for an FSM-synced invoice happen IN the FSM.
  // (Defense-in-depth — a synced invoice should never have a native payment.)
  if (inv?.fieldpulseInvoiceId || inv?.hcpInvoiceId) {
    return { ok: false, reason: "synced_read_only" };
  }

  // ATOMIC CLAIM before the provider refund — the authoritative over-refund
  // guard. One conditional write reserves this refund against the running total
  // (`amountRefundedCents + amount <= amountCents`), so two concurrent refunds
  // can't both pass and pay out more than was charged; the loser matches 0 rows
  // and never calls the provider. Also re-checks status='succeeded' so a
  // concurrent FULL refund (which flips status) blocks further claims.
  const claim = await db
    .update(payments)
    .set({
      amountRefundedCents: sql`${payments.amountRefundedCents} + ${params.amountCents}`,
      updatedAt: new Date(),
    })
    .where(
      withTenant(
        payments,
        organizationId,
        and(
          eq(payments.id, paymentId),
          eq(payments.status, "succeeded"),
          sql`${payments.amountRefundedCents} + ${params.amountCents} <= ${payments.amountCents}`,
        )!,
      ),
    )
    .returning({ id: payments.id });
  if (!claim[0]) {
    // Lost the race / already fully refunded — do NOT call the provider.
    return { ok: false, reason: "exceeds_payment" };
  }

  // Stable idempotency key from invariants (payment + prior refunded total + this
  // amount): a RETRY of the same logical refund yields the same key, so the
  // provider dedupes it — preventing a double money-out if the batch below fails
  // after the provider already succeeded.
  const idempotencyKey = `${paymentId}:${alreadyRefunded}:${params.amountCents}`;
  let result;
  try {
    result = await provider.refund({
      providerPaymentId: pay.providerPaymentId ?? "",
      amountCents: params.amountCents,
      reason: params.reason,
      idempotencyKey,
    });
  } catch (err) {
    // The provider never moved money — UN-CLAIM the reserved amount so a later
    // legitimate refund isn't blocked, then surface the failure.
    await db
      .update(payments)
      .set({
        amountRefundedCents: sql`${payments.amountRefundedCents} - ${params.amountCents}`,
        updatedAt: new Date(),
      })
      .where(withTenant(payments, organizationId, eq(payments.id, paymentId)))
      .catch(() => {});
    throw err;
  }

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
        // ATOMIC decrement off the CURRENT row (floored at 0) — same lost-update
        // guard as takePayment: two refunds against the same invoice must not
        // clobber each other via a precomputed absolute value.
        amountPaidCents: sql`GREATEST(0, ${invoices.amountPaidCents} - ${params.amountCents})`,
        // Fully refunded -> "refunded". Partial refund of a fully-paid invoice
        // stays "paid" (NOT chargeable — prevents over-collection). Partial
        // refund of a partially-paid invoice stays "open" (a real balance remains).
        // Evaluated in SQL on the row being updated: a JS literal from the
        // pre-read could overwrite a concurrent manual payment's "paid" (§5.6).
        state: sql`(CASE WHEN GREATEST(0, ${invoices.amountPaidCents} - ${params.amountCents}) <= 0 THEN 'refunded' WHEN GREATEST(0, ${invoices.amountPaidCents} - ${params.amountCents}) >= ${invoices.totalCents} OR ${invoices.state} = 'paid'::invoice_state THEN 'paid' ELSE 'open' END)::invoice_state`,
        updatedAt: new Date(),
      })
      .where(withTenant(invoices, organizationId, eq(invoices.id, pay.invoiceId))),
  ]);

  return { ok: true, refundId, created: true };
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
        // Manual payments are never pending (spec §5.5) and FieldPulse/HCP
        // mirror payments are not ours to settle; never "reconcile" them.
        sql`${payments.provider} NOT IN ('manual', 'fieldpulse', 'hcp')`,
      ),
    )
    .orderBy(asc(payments.createdAt));
}

export type ReconcileResult =
  | { readonly ok: true; readonly outcome: "completed"; readonly invoiceState: string }
  | { readonly ok: true; readonly outcome: "noop" }
  | { readonly ok: true; readonly outcome: "failed_marked" }
  | {
      readonly ok: false;
      readonly reason: "payment_not_found" | "not_pending" | "synced_read_only";
    };

/**
 * Reconcile a single stranded payment against the provider's true charge status.
 * - succeeded -> complete exactly what takePayment's success path does
 *   (payment->succeeded + recompute invoice amountPaidCents/state via db.batch),
 *   all tenant-scoped. Idempotent: re-reads and only writes while still 'pending'.
 * - failed (or a pending mock payment while cards are disabled) -> mark the
 *   payment failed and un-claim the invoice credit, in ONE batch.
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
      provider: payments.provider,
    })
    .from(payments)
    .where(withTenant(payments, organizationId, eq(payments.id, paymentId)))
    .limit(1);
  if (!pay) return { ok: false, reason: "payment_not_found" };
  // Idempotency: only a still-'pending' payment can be reconciled. If a concurrent
  // reconcile (or a late-landing original batch) already resolved it, no-op.
  if (pay.status !== "pending") return { ok: false, reason: "not_pending" };

  // The mock never moved money while cards are disabled, but the claim already
  // credited the invoice — a permanent `noop` would leave a phantom credit, so a
  // pending mock payment is a FAILED charge (spec §5.7). Otherwise ask the
  // provider (takePayment used paymentId as the createCharge idempotencyKey).
  const charge =
    pay.provider === "mock" && !cardPaymentsEnabled() ? null : await provider.getCharge(paymentId);
  if (charge === null || charge.status === "failed") {
    // The charge did NOT go through, but the invoice was credited at claim time
    // (claim-before-charge). ONE batch: the pending->failed CAS, then the
    // un-claim gated on THIS transaction having written the payment row, so a
    // concurrent reconcile can't decrement twice.
    await db.batch([
      db.execute(failPendingPaymentSql(organizationId, paymentId)),
      db.execute(unclaimInvoiceSql(organizationId, pay.invoiceId, paymentId, pay.amountCents)),
    ]);
    return { ok: true, outcome: "failed_marked" };
  }

  // Provider still 'pending' on its side: leave it for a later sweep rather than
  // guessing. (The mock never returns this; a real adapter might mid-auth.)
  if (charge.status !== "succeeded") {
    return { ok: true, outcome: "noop" };
  }

  // Re-read the invoice (tenant-scoped) to refresh the display state. NOTE: under
  // claim-before-charge, takePayment credits the invoice at CLAIM time — BEFORE
  // this payment row is inserted as 'pending' — so a stranded pending payment's
  // amount is ALREADY in amountPaidCents here. Reconciliation must therefore only
  // flip the payment status + refresh the state hint; it must NOT re-add the
  // amount (that double-credited the invoice on every stranded payment).
  const [inv] = await db
    .select({
      state: invoices.state,
      fieldpulseInvoiceId: invoices.fieldpulseInvoiceId,
      hcpInvoiceId: invoices.hcpInvoiceId,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, pay.invoiceId)))
    .limit(1);
  // Read-only mirror: never credit an FSM-synced invoice from native
  // reconciliation (would double-credit a payment the FSM already recorded).
  if (inv?.fieldpulseInvoiceId || inv?.hcpInvoiceId) {
    return { ok: false, reason: "synced_read_only" };
  }
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

  // Compare-and-set claim: flip pending->succeeded ONLY while still 'pending', so
  // two concurrent reconciles (the manual button + the cron sweep) can't both
  // resolve the same payment. neon-http has no interactive transaction; the CAS
  // is the single-writer gate.
  const claimed = await db
    .update(payments)
    .set({
      status: "succeeded",
      providerPaymentId: charge.providerPaymentId,
      updatedAt: new Date(),
    })
    .where(
      withTenant(
        payments,
        organizationId,
        eq(payments.id, paymentId),
        eq(payments.status, "pending"),
      ),
    )
    .returning({ id: payments.id });
  // Lost the race (someone else already resolved this payment): no-op.
  if (claimed.length === 0) return { ok: true, outcome: "noop" };

  // Refresh the display state ONLY — the money was already credited at claim
  // time in takePayment. Re-adding pay.amountCents here double-credited the
  // invoice (marking a partly-paid invoice fully paid + losing the balance).
  // The state is evaluated in SQL from the row's CURRENT paid amount (which
  // already includes this payment's claim credit), and only over open/paid: a
  // stale JS literal could overwrite a concurrent manual payment's "paid".
  const [written] = await db
    .update(invoices)
    .set({
      state: sql`(CASE WHEN ${invoices.amountPaidCents} >= ${invoices.totalCents} THEN 'paid' ELSE 'open' END)::invoice_state`,
      updatedAt: new Date(),
    })
    .where(
      withTenant(
        invoices,
        organizationId,
        eq(invoices.id, pay.invoiceId),
        sql`${invoices.state} IN ('open'::invoice_state, 'paid'::invoice_state)`,
      ),
    )
    .returning({ state: invoices.state });

  // 0 rows: the invoice left open/paid meanwhile — report the state it kept.
  return { ok: true, outcome: "completed", invoiceState: written?.state ?? inv.state };
}

/** Reconcile failed branch, statement 1: the pending->failed CAS. */
function failPendingPaymentSql(org: string, pid: string): SQL {
  return sql`UPDATE payments SET status = 'failed'::payment_status, updated_at = now()
    WHERE id = ${pid}::uuid AND organization_id = ${org}::uuid AND status = 'pending'::payment_status`;
}

/**
 * Reconcile failed branch, statement 2: un-claim, only if statement 1 won,
 * and only on a native invoice (never decrement a FieldPulse/HCP mirror).
 * Deviation from spec §5.7 (orchestrator ruling): drafts are included and stay
 * drafts — takePayment still claims card payments on drafts, and a phantom
 * credit would freeze line edits (they require amount_paid_cents = 0).
 */
function unclaimInvoiceSql(org: string, inv: string, pid: string, amt: number): SQL {
  return sql`UPDATE invoices SET amount_paid_cents = GREATEST(0, amount_paid_cents - ${amt}::int),
      state = (CASE WHEN state = 'draft'::invoice_state THEN state WHEN GREATEST(0, amount_paid_cents - ${amt}::int) >= total_cents THEN 'paid' ELSE 'open' END)::invoice_state,
      updated_at = now()
    WHERE id = ${inv}::uuid AND organization_id = ${org}::uuid
      AND state IN ('open'::invoice_state, 'paid'::invoice_state, 'draft'::invoice_state)
      AND fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL
      AND EXISTS (SELECT 1 FROM payments WHERE id = ${pid}::uuid AND xmin = pg_current_xact_id()::xid)`;
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
// Org identity — used by the invoice detail page to show the business header.
// ---------------------------------------------------------------------------

/**
 * Returns the org's display identity from organization_settings.
 * companyName: from the text column. phone: parsed from businessInfo JSONB (null when absent or malformed).
 * address: no dedicated column, always returns null.
 */
export async function getInvoiceOrgIdentity(
  organizationId: string,
): Promise<{ companyName: string; address: string | null; phone: string | null }> {
  const [row] = await db
    .select({
      companyName: organizationSettings.companyName,
      businessInfo: organizationSettings.businessInfo,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  const info = businessInfoSchema.safeParse(row?.businessInfo ?? {});
  return {
    companyName: row?.companyName ?? "Your Company",
    address: null,
    phone: info.success ? info.data.phone ?? null : null,
  };
}

/**
 * Net cash collected this calendar month (UTC month boundary — an acceptable
 * approximation for a glance tile): payments received this month minus
 * refunds given this month. A payment that has since been refunded in full
 * reads `refunded`, so it still counts as received; its refund rows subtract.
 * Native money only (FieldPulse-mirrored payments are excluded, and so are any
 * refunds on them). Payments and refunds count only on invoices the viewer
 * sees (both are children of the invoice). neon-http returns sum() as a
 * string, hence the coercion.
 */
export async function collectedThisMonthCents(
  organizationId: string,
  vis: Visibility,
  now: Date = new Date(),
): Promise<number> {
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const [receivedRows, refundedRows] = await db.batch([
    db
      .select({ value: sum(payments.amountCents) })
      .from(payments)
      .innerJoin(
        invoices,
        and(
          eq(invoices.id, payments.invoiceId),
          eq(invoices.organizationId, organizationId),
          visibleRows(invoices, vis),
        ),
      )
      .where(
        withTenant(
          payments,
          organizationId,
          inArray(payments.status, ["succeeded", "refunded"]),
          isNull(payments.fieldpulsePaymentId),
          gte(payments.createdAt, monthStart),
          lt(payments.createdAt, now),
        ),
      ),
    db
      .select({ value: sum(refunds.amountCents) })
      .from(refunds)
      .innerJoin(
        payments,
        and(
          eq(payments.id, refunds.paymentId),
          eq(payments.organizationId, organizationId),
        ),
      )
      .innerJoin(
        invoices,
        and(
          eq(invoices.id, payments.invoiceId),
          eq(invoices.organizationId, organizationId),
          visibleRows(invoices, vis),
        ),
      )
      .where(
        withTenant(
          refunds,
          organizationId,
          isNull(payments.fieldpulsePaymentId),
          gte(refunds.createdAt, monthStart),
          lt(refunds.createdAt, now),
        ),
      ),
  ]);
  return netCollectedCents(receivedRows[0]?.value, refundedRows[0]?.value);
}

/** received − refunded, each a possibly-null/string SQL sum. */
export function netCollectedCents(received: unknown, refunded: unknown): number {
  const toCents = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  return toCents(received) - toCents(refunded);
}

/**
 * Lightweight read of the customerId and synced-source discriminator on an
 * invoice (tenant-scoped). Returns null when the invoice is not found.
 */
export async function getInvoiceCustomerId(
  organizationId: string,
  invoiceId: string,
): Promise<{ customerId: string | null; syncedSource: "fieldpulse" | "housecall" | null } | null> {
  const [row] = await db
    .select({
      customerId: invoices.customerId,
      fieldpulseInvoiceId: invoices.fieldpulseInvoiceId,
      hcpInvoiceId: invoices.hcpInvoiceId,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)))
    .limit(1);
  if (!row) return null;
  return {
    customerId: row.customerId,
    syncedSource: deriveSyncedSource(row.fieldpulseInvoiceId, row.hcpInvoiceId),
  };
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
  readonly createdAt: Date;
  /** When the invoice was issued: the source-system date for FP/HCP mirrors,
   * set for field-finalized native invoices; otherwise null — age math falls
   * back to createdAt. */
  readonly issuedAt: Date | null;
  /** Source-system due date; drives overdue when present. */
  readonly dueDate: Date | null;
  readonly customerName: string | null;
  readonly lastReminderSentAt: Date | null;
  /** Which FSM this read-only invoice is mirrored from, or null when native. */
  readonly syncedSource: "fieldpulse" | "housecall" | null;
}

/**
 * The keys of a list row: only what the list renders (speed S3). The
 * FieldPulse blob and the request link live on the detail endpoint; an
 * expanded FieldPulse row fetches its details from there.
 */
export const LIST_INVOICE_FIELDS = [
  "id",
  "state",
  "totalCents",
  "amountPaidCents",
  "customerId",
  "createdAt",
  "issuedAt",
  "dueDate",
  "customerName",
  "lastReminderSentAt",
  "syncedSource",
] as const satisfies readonly (keyof InvoiceListRow)[];

export interface InvoiceSummaryStats {
  readonly outstandingCents: number;
  readonly outstandingCount: number;
  readonly overdueCents: number;
  readonly overdueCount: number;
  /** Max days-past-due across overdue open invoices; 0 when no overdue invoices. */
  readonly oldestOverdueDays: number;
}

export interface InvoiceListPage {
  readonly invoices: readonly InvoiceListRow[];
  readonly total: number;
  readonly sourceCounts: Record<string, number>;
}

/** Which FSM (if any) a row is a read-only mirror of. FieldPulse wins the rare
 * dual-source row; null means a native (editable) invoice. */
function deriveSyncedSource(
  fieldpulseInvoiceId: string | null,
  hcpInvoiceId: string | null,
): "fieldpulse" | "housecall" | null {
  return fieldpulseInvoiceId != null
    ? "fieldpulse"
    : hcpInvoiceId != null
      ? "housecall"
      : null;
}

/**
 * Server-side summary stats for the invoices SummaryBand. Computes Outstanding
 * and Overdue in SQL so the numbers stay correct after pagination removes the
 * full client list. isCollectible semantics: state='open' AND total>paid.
 * overdueByDates semantics: past dueDate (when present) OR age >= 30 days.
 * Neon returns ::bigint columns as strings — wrapped with Number(). Hidden
 * invoices are left out exactly as listInvoices leaves them out, so each tile
 * is the sum over the rows the list shows.
 */
export async function getInvoiceSummaryStats(
  organizationId: string,
  vis: Visibility,
): Promise<InvoiceSummaryStats> {
  const [row] = await db
    .select({
      outstandingCents: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}), 0)::bigint`,
      outstandingCount: sql<number>`count(*)::int`,
      overdueCents: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}) filter (where ${overdueWhere(invoices)}), 0)::bigint`,
      overdueCount: sql<number>`count(*) filter (where ${overdueWhere(invoices)})::int`,
      oldestOverdueDays: sql<number>`coalesce(max(
        case
          when ${invoices.dueDate} is not null and ${invoices.dueDate} < now() - interval '1 day'
            then extract(day from now() - ${invoices.dueDate})
          when ${invoices.dueDate} is null and coalesce(${invoices.issuedAt}, ${invoices.createdAt}) <= now() - interval '30 days'
            then extract(day from now() - coalesce(${invoices.issuedAt}, ${invoices.createdAt})) - 30
          else 0
        end
      ) filter (where ${overdueWhere(invoices)}), 0)::bigint`,
    })
    .from(invoices)
    .where(
      withTenant(
        invoices,
        organizationId,
        eq(invoices.state, "open"),
        sql`${invoices.totalCents} > ${invoices.amountPaidCents}`,
        visibleRows(invoices, vis),
      ),
    );

  return {
    outstandingCents: Number(row?.outstandingCents ?? 0),
    outstandingCount: Number(row?.outstandingCount ?? 0),
    overdueCents: Number(row?.overdueCents ?? 0),
    overdueCount: Number(row?.overdueCount ?? 0),
    oldestOverdueDays: Number(row?.oldestOverdueDays ?? 0),
  };
}

const INVOICES_PAGE_SIZE = 50;

/** Whitelisted server-side sort keys. */
export type InvoiceSortKey = 'newest' | 'oldest' | 'balance-high' | 'age-oldest';

export const INVOICE_SORT_KEYS: ReadonlySet<InvoiceSortKey> = new Set([
  'newest',
  'oldest',
  'balance-high',
  'age-oldest',
]);

export interface ListInvoicesOptions {
  readonly page?: number;
  readonly limit?: number;
  readonly search?: string;
  /** Filter by invoice state (enum: draft|open|paid|void|refunded). */
  readonly state?: string;
  /** When true, further restrict state=open rows to overdue only (same predicate as getInvoiceSummaryStats). */
  readonly overdue?: boolean;
  /** Filter by source: 'native' (both synced ids null), 'fieldpulse', 'housecall'. */
  readonly source?: string;
  /** Sort order. Defaults to 'newest'. */
  readonly sort?: InvoiceSortKey;
  /** When true, filter to invoices that have never had a reminder sent. */
  readonly unreminded?: boolean;
  /** Minimum outstanding balance in cents (inclusive). Outstanding = totalCents - coalesce(amountPaidCents, 0). */
  readonly minCents?: number;
  /** Maximum outstanding balance in cents (inclusive). Outstanding = totalCents - coalesce(amountPaidCents, 0). */
  readonly maxCents?: number;
  /** Scope to a single customer (used by ScopedInvoicesSection). */
  readonly customerId?: string;
  /** Scope to a single service request (used by ScopedInvoicesSection). */
  readonly serviceRequestId?: string;
}

// The overdue predicate used in getInvoiceSummaryStats, reused here for server-side overdue filter.
// Returned as a factory (not a module-level const) to avoid calling sql`` at import time,
// which breaks tests that mock drizzle-orm without the sql export.
function makeOverduePredicate() {
  return sql`(
  (${invoices.dueDate} is not null and ${invoices.dueDate} < now() - interval '1 day')
  or (${invoices.dueDate} is null and coalesce(${invoices.issuedAt}, ${invoices.createdAt}) <= now() - interval '30 days')
)`;
}

/** Admin list of an org's invoices, server-paginated. */
export async function listInvoices(
  organizationId: string,
  opts: ListInvoicesOptions,
  vis: Visibility,
): Promise<InvoiceListPage> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.max(1, opts.limit ?? INVOICES_PAGE_SIZE);
  const offset = (page - 1) * limit;
  const search = opts.search?.trim().toLowerCase() ?? "";

  // Build extra WHERE conditions beyond the tenant scope.
  // extraConditionsNoSource mirrors extraConditions but omits the source filter
  // so the sourceCounts facet shows real per-source counts regardless of active tab.
  const extraConditions: ReturnType<typeof eq>[] = [];
  const extraConditionsNoSource: ReturnType<typeof eq>[] = [];

  const pushCond = (c: ReturnType<typeof eq>, includeInNoSource = true) => {
    extraConditions.push(c);
    if (includeInNoSource) extraConditionsNoSource.push(c);
  };

  if (opts.state) {
    pushCond(eq(invoices.state, opts.state as "draft" | "open" | "paid" | "void" | "refunded"));
  }
  // Overdue filter: state=open AND total>paid AND overdue predicate.
  // Must be combined with state=open (caller is expected to set state='open').
  if (opts.overdue) {
    pushCond(sql`${invoices.totalCents} > ${invoices.amountPaidCents}` as ReturnType<typeof eq>);
    pushCond(makeOverduePredicate() as ReturnType<typeof eq>);
  }
  if (opts.source === "native") {
    // source predicates: included in rows/count WHERE, excluded from facet WHERE
    pushCond(isNull(invoices.fieldpulseInvoiceId) as ReturnType<typeof eq>, false);
    pushCond(isNull(invoices.hcpInvoiceId) as ReturnType<typeof eq>, false);
  } else if (opts.source === "fieldpulse") {
    pushCond(isNotNull(invoices.fieldpulseInvoiceId) as ReturnType<typeof eq>, false);
  } else if (opts.source === "housecall") {
    pushCond(isNotNull(invoices.hcpInvoiceId) as ReturnType<typeof eq>, false);
  }
  if (opts.unreminded) {
    pushCond(isNull(invoices.lastReminderSentAt) as ReturnType<typeof eq>);
  }
  // Balance range filters — reuse the same SQL expression as the 'balance-high' sort key
  // so the two never drift: totalCents - amountPaidCents.
  const balanceExpr = sql`${invoices.totalCents} - ${invoices.amountPaidCents}`;
  if (opts.minCents !== undefined && Number.isFinite(opts.minCents) && opts.minCents >= 0) {
    pushCond(gte(balanceExpr, opts.minCents) as ReturnType<typeof eq>);
  }
  if (opts.maxCents !== undefined && Number.isFinite(opts.maxCents) && opts.maxCents >= 0) {
    pushCond(lte(balanceExpr, opts.maxCents) as ReturnType<typeof eq>);
  }
  if (opts.customerId) {
    pushCond(eq(invoices.customerId, opts.customerId));
  }
  if (opts.serviceRequestId) {
    pushCond(eq(invoices.serviceRequestId, opts.serviceRequestId));
  }

  const whereClause = withTenant(invoices, organizationId, ...extraConditions);
  // sourceCounts facet uses WHERE without the source filter so each tab shows
  // its real count even when another source tab is active.
  const whereClauseNoSource = withTenant(invoices, organizationId, ...extraConditionsNoSource);

  // Resolve ORDER BY from sort key.
  function resolveOrderBy(sortKey?: InvoiceSortKey) {
    switch (sortKey) {
      case 'oldest':
        return asc(sql`coalesce(${invoices.issuedAt}, ${invoices.createdAt})`);
      case 'balance-high':
        return desc(sql`${invoices.totalCents} - ${invoices.amountPaidCents}`);
      case 'age-oldest':
        // Unpaid invoices ordered by age descending; paid/zero-balance invoices sorted last.
        return desc(sql`case when ${invoices.totalCents} > ${invoices.amountPaidCents} then extract(epoch from now() - coalesce(${invoices.issuedAt}, ${invoices.createdAt})) else -1 end`);
      case 'newest':
      default:
        return desc(sql`coalesce(${invoices.issuedAt}, ${invoices.createdAt})`);
    }
  }
  const orderByClause = resolveOrderBy(opts.sort);

  // sourceCounts facet: classify each row into native/fieldpulse/housecall.
  // Uses whereClauseNoSource so counts are correct for all tabs simultaneously.
  // Runs in the same Promise.all to add no serial latency.
  const sourceExpr = sql<string>`
    case
      when ${invoices.fieldpulseInvoiceId} is not null then 'fieldpulse'
      when ${invoices.hcpInvoiceId} is not null then 'housecall'
      else 'native'
    end
  `;
  const sourceCountsPromise = db
    .select({
      source: sourceExpr,
      n: sql<number>`count(*)::int`,
    })
    .from(invoices)
    .where(and(whereClauseNoSource, visibleRows(invoices, vis)))
    .groupBy(sourceExpr)
    .then((rows) => {
      const m: Record<string, number> = {};
      for (const r of rows) {
        m[r.source] = Number(r.n);
      }
      return m;
    });

  const countPromise = db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(whereClause, visibleRows(invoices, vis)));

  const rowCols = {
    id: invoices.id,
    state: invoices.state,
    totalCents: invoices.totalCents,
    amountPaidCents: invoices.amountPaidCents,
    customerId: invoices.customerId,
    createdAt: invoices.createdAt,
    issuedAt: invoices.issuedAt,
    dueDate: invoices.dueDate,
    lastReminderSentAt: invoices.lastReminderSentAt,
    fieldpulseInvoiceId: invoices.fieldpulseInvoiceId,
    hcpInvoiceId: invoices.hcpInvoiceId,
    nameEncrypted: customers.nameEncrypted,
  };

  const rowsPromise = db
    .select(rowCols)
    .from(invoices)
    // Org-scope the join too (defense in depth). A hidden customer contributes no name.
    .leftJoin(
      customers,
      and(
        eq(customers.id, invoices.customerId),
        eq(customers.organizationId, organizationId),
        visibleRows(customers, vis),
      ),
    )
    .where(and(whereClause, visibleRows(invoices, vis)))
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  if (search) {
    // Customer name is encrypted — decrypt every row server-side and filter.
    // For reference/id prefix search we can also do it here after decryption.
    // Load ALL matching rows (no pagination), decrypt, filter, then slice.
    // Cap the decrypt-scan to the most recent 5 000 rows (newest-first ordering
    // is already applied) — mirrors the SCAN_LIMIT_INVOICES cap in search-queries.ts.
    // Without this the query fetches ALL org rows on every keystroke.
    const allRowsPromise = db
      .select(rowCols)
      .from(invoices)
      .leftJoin(
        customers,
        and(
          eq(customers.id, invoices.customerId),
          eq(customers.organizationId, organizationId),
          visibleRows(customers, vis),
        ),
      )
      .where(and(whereClause, visibleRows(invoices, vis)))
      .orderBy(orderByClause)
      .limit(5000);

    // countPromise is not needed in the search path: filtered.length is the true total.
    // sourceCountsPromise (SQL) can't see decrypted names, so we discard it and
    // recompute facets from the filtered JS row set so tabs match visible results.
    const [, allRows] = await Promise.all([
      sourceCountsPromise,
      allRowsPromise,
    ]);

    // Decrypt and filter
    const filtered = allRows.filter(({ nameEncrypted, id, fieldpulseInvoiceId }) => {
      const name = safeDecryptName(nameEncrypted);
      const ref = `#${id.slice(0, 8).toUpperCase()}`;
      const fpId = fieldpulseInvoiceId ?? "";
      return (
        (name ?? "").toLowerCase().includes(search) ||
        ref.toLowerCase().includes(search) ||
        id.toLowerCase().includes(search) ||
        fpId.toLowerCase().includes(search)
      );
    });

    // Compute sourceCounts from the filtered row set (mirrors the SQL CASE in sourceCountsPromise).
    // Non-search path keeps the SQL facet; search path uses JS so tabs match visible results.
    const sourceCounts: Record<string, number> = {};
    for (const { fieldpulseInvoiceId, hcpInvoiceId } of filtered) {
      const src = fieldpulseInvoiceId != null ? 'fieldpulse' : hcpInvoiceId != null ? 'housecall' : 'native';
      sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;
    }

    const sliced = filtered.slice(offset, offset + limit);
    const invoiceRows = sliced.map(({ fieldpulseInvoiceId, hcpInvoiceId, nameEncrypted, ...r }) => ({
      ...r,
      customerName: safeDecryptName(nameEncrypted),
      syncedSource: deriveSyncedSource(fieldpulseInvoiceId, hcpInvoiceId),
    }));

    return {
      invoices: invoiceRows,
      total: filtered.length,
      sourceCounts,
    };
  }

  const [countResult, sourceCounts, rows] = await Promise.all([
    countPromise,
    sourceCountsPromise,
    rowsPromise,
  ]);

  const invoiceRows = rows.map(({ fieldpulseInvoiceId, hcpInvoiceId, nameEncrypted, ...r }) => ({
    ...r,
    customerName: safeDecryptName(nameEncrypted),
    syncedSource: deriveSyncedSource(fieldpulseInvoiceId, hcpInvoiceId),
  }));

  return {
    invoices: invoiceRows,
    total: Number(countResult[0]?.n ?? 0),
    sourceCounts,
  };
}

/** Decrypt an encrypted name for display; null on absent/garbled ciphertext. */
function safeDecryptName(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
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
  /** "card" | "cash" | "check" | "other". */
  readonly method: string;
  readonly checkNumber: string | null;
  /** "mock" | "stripe" | "fieldpulse" | "manual". */
  readonly provider: string;
  readonly refunds: RefundView[];
}

export interface SignatureView {
  readonly url: string | null;
  readonly name: string | null;
  readonly signedAt: Date | null;
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
  /** When the invoice was issued: the source-system date for FP/HCP mirrors,
   * set for field-finalized native invoices; otherwise null — age math falls
   * back to createdAt. */
  readonly issuedAt: Date | null;
  /** Source-system due date; drives overdue when present. */
  readonly dueDate: Date | null;
  /** Which FSM this read-only invoice is mirrored from, or null when native. */
  readonly syncedSource: "fieldpulse" | "housecall" | null;
  /** FieldPulse spillover data for the detail panel; null when not a FP invoice or empty. */
  readonly fieldpulseData: Record<string, unknown> | null;
  readonly lineItems: InvoiceLineItemView[];
  readonly payments: PaymentView[];
  /**
   * ACTUAL materials cost (cents) the tech recorded on the linked service
   * request, if any. NULL when the invoice has no linked job or no field
   * materials were recorded. Distinct from the estimated line-snapshot cost —
   * shown alongside it, never replacing it. ADMIN-ONLY (sensitive cost data).
   */
  readonly actualMaterialsCostCents: number | null;
  /**
   * ACTUAL labor cost (cents) from the closed time entries the tech logged on
   * the linked service request, if any. NULL when there's no linked job or no
   * CLOSED time entries. The actual margin subtracts actual materials + this;
   * shown as its own line. ADMIN-ONLY (sensitive cost data).
   */
  readonly actualLaborCostCents: number | null;
  readonly customerName: string | null;
  readonly customerAddress: string | null;
  readonly customerPhone: string | null;
  readonly technicianName: string | null;
  readonly serviceDate: Date | null;
  readonly lastReminderSentAt: Date | null;
  /** The INVOICE's own signature snapshot (taken at finalize). */
  readonly signature: SignatureView;
  /** The request's CURRENT signature — drafts only (not yet on the invoice); null otherwise. */
  readonly requestSignature: SignatureView | null;
}

/**
 * Detail view: invoice header + its line items + its payments (each with that
 * payment's refunds). All reads tenant-scoped. Returns null if not found, or
 * if the invoice is hidden from this viewer (the route answers 404).
 */
export async function getInvoiceDetailById(
  organizationId: string,
  id: string,
  vis: Visibility,
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
      issuedAt: invoices.issuedAt,
      dueDate: invoices.dueDate,
      fieldpulseInvoiceId: invoices.fieldpulseInvoiceId,
      hcpInvoiceId: invoices.hcpInvoiceId,
      fieldpulseData: invoices.fieldpulseData,
      nameEncrypted: customers.nameEncrypted,
      addressEncrypted: customers.addressEncrypted,
      phoneEncrypted: customers.phoneEncrypted,
      technicianName: users.name,
      serviceDate: serviceRequests.scheduledDate,
      lastReminderSentAt: invoices.lastReminderSentAt,
      signatureUrl: invoices.signatureUrl,
      signatureName: invoices.signatureName,
      signedAt: invoices.signedAt,
      requestSignatureUrl: serviceRequests.signatureUrl,
      requestSignatureName: serviceRequests.signatureName,
      requestSignedAt: serviceRequests.signedAt,
    })
    .from(invoices)
    // A hidden customer or request contributes no name, contact or job details.
    .leftJoin(customers, and(eq(customers.id, invoices.customerId), eq(customers.organizationId, organizationId), visibleRows(customers, vis)))
    .leftJoin(serviceRequests, and(eq(serviceRequests.id, invoices.serviceRequestId), eq(serviceRequests.organizationId, organizationId), visibleRows(serviceRequests, vis)))
    .leftJoin(users, and(eq(users.id, serviceRequests.assignedTo), eq(users.organizationId, organizationId)))
    .where(withTenant(invoices, organizationId, eq(invoices.id, id), visibleRows(invoices, vis)))
    .limit(1);

  // Line items, payments and refunds below are children of this row: read only once it passed.
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
      method: payments.method,
      checkNumber: payments.checkNumber,
      provider: payments.provider,
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
  // Actual LABOR cost, rolled up from the CLOSED time entries the tech logged on
  // the linked service request. NULL when there's no linked job or no closed
  // entries — distinct from (and shown alongside) the actual-materials figure,
  // so the actual margin can subtract both: revenue − materials − labor.
  let actualLaborCostCents: number | null = null;
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

    const laborRows = await db
      .select({ laborCostCents: technicianTimeEntries.laborCostCents })
      .from(technicianTimeEntries)
      .where(
        withTenant(
          technicianTimeEntries,
          organizationId,
          eq(technicianTimeEntries.serviceRequestId, inv.serviceRequestId),
        ),
      );
    // Only CLOSED entries carry a non-null laborCostCents; if none are closed
    // yet, keep NULL so the UI doesn't show a 0 "actual labor" line.
    const hasClosedLabor = laborRows.some((r) => r.laborCostCents !== null);
    actualLaborCostCents = hasClosedLabor
      ? rollUpActualLaborCost(laborRows)
      : null;
  }

  // Keep the raw FSM ids and encrypted fields server-side; expose only derived values.
  const {
    fieldpulseInvoiceId,
    hcpInvoiceId,
    fieldpulseData,
    nameEncrypted,
    addressEncrypted,
    phoneEncrypted,
    signatureUrl,
    signatureName,
    signedAt,
    requestSignatureUrl,
    requestSignatureName,
    requestSignedAt,
    ...invRest
  } = inv;
  return {
    ...invRest,
    signature: { url: signatureUrl ?? null, name: signatureName ?? null, signedAt: signedAt ?? null },
    requestSignature:
      inv.state === "draft"
        ? { url: requestSignatureUrl ?? null, name: requestSignatureName ?? null, signedAt: requestSignedAt ?? null }
        : null,
    syncedSource: deriveSyncedSource(fieldpulseInvoiceId, hcpInvoiceId),
    fieldpulseData: (fieldpulseData as Record<string, unknown> | null) ?? null,
    customerName: safeDecryptName(nameEncrypted),
    customerAddress: safeDecryptName(addressEncrypted),
    customerPhone: safeDecryptName(phoneEncrypted),
    lineItems,
    payments: paymentRows.map((p) => ({
      ...p,
      refunds: refundsByPayment.get(p.id) ?? [],
    })),
    actualMaterialsCostCents,
    actualLaborCostCents,
  };
}

/**
 * Voids a NATIVE, unpaid, open/draft invoice (terminal state). Refuses synced
 * invoices (money owned externally), invoices with any recorded payment (refund
 * first), and already-terminal states. Read classifies the failure reason; the
 * guarded UPDATE ... RETURNING re-checks every guard for atomicity (neon-http
 * has no row locks).
 */
export async function voidInvoice(
  organizationId: string,
  invoiceId: string,
  now: Date = new Date(),
): Promise<
  | { ok: true }
  | { ok: false; reason: "not_found" | "synced_read_only" | "not_voidable" | "has_payments" }
> {
  const [inv] = await db
    .select({
      state: invoices.state,
      amountPaidCents: invoices.amountPaidCents,
      fieldpulseInvoiceId: invoices.fieldpulseInvoiceId,
      hcpInvoiceId: invoices.hcpInvoiceId,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)))
    .limit(1);

  if (!inv) return { ok: false, reason: "not_found" };
  if (inv.fieldpulseInvoiceId || inv.hcpInvoiceId) return { ok: false, reason: "synced_read_only" };
  if (inv.state !== "open" && inv.state !== "draft") return { ok: false, reason: "not_voidable" };
  if (inv.amountPaidCents > 0) return { ok: false, reason: "has_payments" };

  const [claimed] = await db
    .update(invoices)
    .set({ state: "void", updatedAt: now })
    .where(
      withTenant(
        invoices,
        organizationId,
        eq(invoices.id, invoiceId),
        inArray(invoices.state, ["open", "draft"]),
        eq(invoices.amountPaidCents, 0),
        isNull(invoices.fieldpulseInvoiceId),
        isNull(invoices.hcpInvoiceId),
      ),
    )
    .returning({ id: invoices.id });

  if (!claimed) return { ok: false, reason: "not_voidable" };
  return { ok: true };
}

export interface InvoiceReminderView {
  readonly at: Date;
  readonly channel: string;
  readonly status: string;
}

/**
 * Org-scoped list of reminder jobs sent for a specific invoice. Matches by
 * invoiceId in templateVariables (new path) or by invoiceRef (legacy path
 * for jobs queued before invoiceId was added). Newest-first, capped at 20.
 */
export async function listInvoiceReminders(
  organizationId: string,
  invoiceId: string,
): Promise<InvoiceReminderView[]> {
  const rows = await db
    .select({
      channel: communicationJobs.channel,
      status: communicationJobs.status,
      completedAt: communicationJobs.completedAt,
      createdAt: communicationJobs.createdAt,
    })
    .from(communicationJobs)
    .where(
      withTenant(
        communicationJobs,
        organizationId,
        and(
          eq(communicationJobs.triggerType, "invoice_overdue"),
          or(
            sql`${communicationJobs.templateVariables}->>'invoiceId' = ${invoiceId}`,
            sql`${communicationJobs.templateVariables}->>'invoiceNumber' = ${invoiceRef(invoiceId)}`,
          ),
        )!,
      ),
    )
    .orderBy(desc(sql`COALESCE(${communicationJobs.completedAt}, ${communicationJobs.createdAt})`))
    .limit(20);

  return rows.map((r) => ({
    at: r.completedAt ?? r.createdAt,
    channel: r.channel,
    status: r.status,
  }));
}
