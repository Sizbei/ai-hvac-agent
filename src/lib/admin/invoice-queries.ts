/**
 * Stage 9 — native invoicing + payments + refunds (path B, for non-FSM orgs).
 *
 * Money moves through the PaymentProvider seam (mock until Stripe keys exist).
 * Line items snapshot from the sold estimate option. Refunds/credits are
 * first-class (a half-built payments path breaks on the first chargeback).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  estimates,
  estimateOptions,
  estimateLineItems,
  invoices,
  invoiceLineItems,
  payments,
  refunds,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
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
  | { readonly ok: false; readonly reason: "invoice_not_found" | "charge_failed" };

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
      totalCents: invoices.totalCents,
      amountPaidCents: invoices.amountPaidCents,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)))
    .limit(1);
  if (!inv) return { ok: false, reason: "invoice_not_found" };

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
  | { readonly ok: false; readonly reason: "payment_not_found" | "exceeds_payment" };

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
      providerPaymentId: payments.providerPaymentId,
    })
    .from(payments)
    .where(withTenant(payments, organizationId, eq(payments.id, paymentId)))
    .limit(1);
  if (!pay) return { ok: false, reason: "payment_not_found" };
  if (params.amountCents > pay.amountCents) {
    return { ok: false, reason: "exceeds_payment" };
  }

  const result = await provider.refund({
    providerPaymentId: pay.providerPaymentId ?? "",
    amountCents: params.amountCents,
    reason: params.reason,
  });

  const refundId = randomUUID();
  const [inv] = await db
    .select({ amountPaidCents: invoices.amountPaidCents, totalCents: invoices.totalCents })
    .from(invoices)
    .where(eq(invoices.id, pay.invoiceId))
    .limit(1);
  const newPaid = Math.max(0, (inv?.amountPaidCents ?? 0) - params.amountCents);

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
      .set({ status: "refunded", updatedAt: new Date() })
      .where(eq(payments.id, paymentId)),
    db
      .update(invoices)
      .set({
        amountPaidCents: newPaid,
        state: newPaid <= 0 ? "refunded" : "open",
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, pay.invoiceId)),
  ]);

  return { ok: true, refundId };
}
