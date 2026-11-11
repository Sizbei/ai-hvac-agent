/**
 * "Collected" = cash actually received in a period, by PAYMENT date, in the
 * business timezone. Shared by the Reports "Collected" tile and the invoices
 * page's "Collected this month". Client-safe (no db import).
 *
 * Sources, and the one rule that keeps them from double counting: every
 * invoice's money comes from exactly ONE source.
 *  - FieldPulse invoice (fieldpulse_invoice_id set): only its mirrored
 *    FieldPulse payment rows count (fieldpulse_payment_id set, status
 *    succeeded, created_at = the real payment date). The invoice's
 *    amount_paid_cents is NEVER read for collected money: it is the same money
 *    as those payment rows, summed by FieldPulse.
 *  - Native invoice (no FieldPulse / Housecall Pro id): only native payment
 *    rows (fieldpulse_payment_id null) count, less refunds by refund date.
 *  - Housecall Pro invoice: no per-payment rows are stored, so HCP money has
 *    no payment date and is not in "collected".
 * A native payment on a synced invoice (refused by takePayment and
 * recordManualPayment) or a FieldPulse payment on a native invoice (the
 * importer only links to FieldPulse invoices) is never counted, so a future
 * write-path bug cannot double count either.
 */
import { businessIsoDate, businessWallClockToUtc } from './calendar-time';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CashWindow {
  /** Inclusive. Business-timezone midnight. */
  readonly from: Date;
  /** Exclusive. */
  readonly to: Date;
}

/** ISO date `days` calendar days before `isoDate` (whole-day UTC stepping is tz-free). */
function isoDaysBefore(isoDate: string, days: number): string {
  return new Date(new Date(`${isoDate}T00:00:00.000Z`).getTime() - days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * "Last N days" ending now: today (business tz) and the N-1 days before it,
 * from that first day's New York midnight. DST-correct.
 */
export function lastNDaysWindow(now: Date, days: number): CashWindow {
  const firstDay = isoDaysBefore(businessIsoDate(now), Math.max(1, Math.floor(days)) - 1);
  return { from: businessWallClockToUtc(firstDay, 0, 0), to: now };
}

/** "This month": from the 1st of the current business-tz month, New York midnight. */
export function monthToDateWindow(now: Date): CashWindow {
  const first = `${businessIsoDate(now).slice(0, 7)}-01`;
  return { from: businessWallClockToUtc(first, 0, 0), to: now };
}

export interface PaymentFacts {
  readonly fieldpulsePaymentId: string | null;
  readonly status: string;
  readonly invoiceFieldpulseId: string | null;
  readonly invoiceHcpId: string | null;
}

/**
 * Which collected bucket a payment row feeds, or null when it must not count.
 * The SQL in reporting-queries / invoice-queries applies the same predicates
 * (FIELDPULSE_COLLECTED / NATIVE_COLLECTED there); keep the two in step.
 */
export function collectedSource(p: PaymentFacts): "fieldpulse" | "native" | null {
  const nativeInvoice = p.invoiceFieldpulseId === null && p.invoiceHcpId === null;
  if (p.fieldpulsePaymentId !== null) {
    // FieldPulse 'refunded' rows carry amount_refunded_cents = 0, so counting
    // them would add money that went back. Only settled ones count.
    return p.invoiceFieldpulseId !== null && p.status === "succeeded" ? "fieldpulse" : null;
  }
  // A fully refunded native payment reads 'refunded'; it was still received,
  // and its refund rows subtract separately.
  return nativeInvoice && (p.status === "succeeded" || p.status === "refunded") ? "native" : null;
}

export interface PaymentRow extends PaymentFacts {
  readonly amountCents: number;
  readonly amountRefundedCents: number;
  readonly paidAt: Date;
}

export interface RefundRow {
  readonly amountCents: number;
  readonly refundedAt: Date;
  /** The refunded payment. */
  readonly payment: PaymentFacts;
}

export interface CollectedParts {
  readonly fieldpulseCents: number;
  readonly nativeReceivedCents: number;
  readonly nativeRefundedCents: number;
}

function inWindow(at: Date, w: CashWindow): boolean {
  return at.getTime() >= w.from.getTime() && at.getTime() < w.to.getTime();
}

/** Reference implementation of the collected rule over plain rows (what the SQL computes). */
export function collectedParts(
  paymentRows: readonly PaymentRow[],
  refundRows: readonly RefundRow[],
  w: CashWindow,
): CollectedParts {
  let fieldpulseCents = 0;
  let nativeReceivedCents = 0;
  for (const p of paymentRows) {
    if (!inWindow(p.paidAt, w)) continue;
    const source = collectedSource(p);
    if (source === "fieldpulse") fieldpulseCents += p.amountCents - p.amountRefundedCents;
    else if (source === "native") nativeReceivedCents += p.amountCents;
  }
  let nativeRefundedCents = 0;
  for (const r of refundRows) {
    if (inWindow(r.refundedAt, w) && collectedSource(r.payment) === "native") {
      nativeRefundedCents += r.amountCents;
    }
  }
  return { fieldpulseCents, nativeReceivedCents, nativeRefundedCents };
}

export function collectedTotalCents(p: CollectedParts): number {
  return p.fieldpulseCents + p.nativeReceivedCents - p.nativeRefundedCents;
}
