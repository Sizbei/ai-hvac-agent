/**
 * Parity Stage 10 — QuickBooks / accounting export (READ-ONLY).
 *
 * Builds a period-scoped, double-entry-friendly JOURNAL from the Stage 9 money
 * tables (invoices, payments, refunds) plus Stage 6 labor (technician_time_
 * entries), in a QBO-compatible shape. Nothing here writes to any money table.
 *
 * MONEY: stored as integer cents everywhere; QBO/CSV expects decimal dollars, so
 * cents are converted to dollars ONLY at this export boundary (centsToDollars),
 * never by mutating stored cents.
 *
 * TENANCY: every query is withTenant + period-scoped. A cross-org sum is a
 * tenant breach.
 *
 * PII: memos carry NON-SENSITIVE ids only (invoice/payment/refund/time-entry
 * ids) — never customer names, emails, addresses, or free-text. The exported
 * FILE does contain amounts, so the route that serves it is super_admin-gated.
 */
import { eq, gte, lte, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  invoices,
  payments,
  refunds,
  technicianTimeEntries,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

/** QBO-style account names the journal posts against. */
export type AccountName =
  | "Sales Revenue"
  | "Undeposited Funds"
  | "Refunds & Allowances"
  | "Labor Cost";

export type JournalLineType = "invoice" | "payment" | "refund" | "labor";

export interface JournalLine {
  /** ISO date (YYYY-MM-DD) the line is dated on. */
  readonly date: string;
  readonly type: JournalLineType;
  /** QBO account the amount posts to. */
  readonly account: AccountName;
  /** Non-sensitive memo — ids only, never customer PII. */
  readonly memo: string;
  /** Amount in decimal DOLLARS (cents/100). Always positive; `type`/`account`
   * carry the debit/credit semantics. */
  readonly amountDollars: number;
}

export interface AccountingExportPeriod {
  readonly fromDate: Date;
  readonly toDate: Date;
}

/**
 * The full export result, partitioned to prevent accidental blending.
 *
 * `native` — transactions created natively in this system; safe to import into
 *   your ledger.
 * `synced` — transactions mirrored read-only from FieldPulse; already recorded
 *   in FieldPulse's own books. Listed separately for reconciliation only — do
 *   NOT import them alongside `native` rows or money will be double-counted.
 */
export interface AccountingExportResult {
  readonly native: readonly JournalLine[];
  readonly synced: readonly JournalLine[];
}

/** Integer cents -> decimal dollars, rounded to 2 dp (no float drift). */
function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

/** YYYY-MM-DD in UTC (stable, locale-independent — accounting wants a date). */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the period journal for an org, partitioned into native and
 * FieldPulse-synced sections. All reads are tenant-scoped and period-scoped.
 *
 * NATIVE (fieldpulseInvoiceId IS NULL, fieldpulsePaymentId IS NULL):
 *   invoice → Sales Revenue, payment → Undeposited Funds, refund → contra,
 *   labor → Labor Cost. Safe to import into your ledger.
 *
 * SYNCED (fieldpulseInvoiceId/fieldpulsePaymentId IS NOT NULL):
 *   FieldPulse already books these. Listed for reconciliation only — importing
 *   them alongside native rows double-counts money. Refunds and labor rows are
 *   always native (no FP mirror for those tables).
 */
export async function getAccountingExport(
  organizationId: string,
  period: AccountingExportPeriod,
): Promise<AccountingExportResult> {
  const { fromDate, toDate } = period;

  const [
    nativeInvoiceRows,
    syncedInvoiceRows,
    nativePaymentRows,
    syncedPaymentRows,
    refundRows,
    laborRows,
  ] = await Promise.all([
    // Native invoices (not from FP or HCP) -> revenue recognized.
    db
      .select({
        id: invoices.id,
        subtotalCents: invoices.subtotalCents,
        taxCents: invoices.taxCents,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .where(
        withTenant(
          invoices,
          organizationId,
          isNull(invoices.fieldpulseInvoiceId),
          isNull(invoices.hcpInvoiceId),
          gte(invoices.createdAt, fromDate),
          lte(invoices.createdAt, toDate),
        ),
      ),

    // Synced invoices (FP-mirrored) — listed separately, NOT imported to ledger.
    db
      .select({
        id: invoices.id,
        subtotalCents: invoices.subtotalCents,
        taxCents: invoices.taxCents,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .where(
        withTenant(
          invoices,
          organizationId,
          isNotNull(invoices.fieldpulseInvoiceId),
          gte(invoices.createdAt, fromDate),
          lte(invoices.createdAt, toDate),
        ),
      ),

    // Native payments (not FP-synced) -> cash received.
    db
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
          eq(payments.status, "succeeded"),
          isNull(payments.fieldpulsePaymentId),
          gte(payments.createdAt, fromDate),
          lte(payments.createdAt, toDate),
        ),
      ),

    // Synced payments (FP-mirrored) — listed separately, NOT imported to ledger.
    db
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
          eq(payments.status, "succeeded"),
          isNotNull(payments.fieldpulsePaymentId),
          gte(payments.createdAt, fromDate),
          lte(payments.createdAt, toDate),
        ),
      ),

    // Refunds issued in the period -> contra (Refunds & Allowances).
    // Refunds are always native; no FP mirror for this table.
    db
      .select({
        id: refunds.id,
        paymentId: refunds.paymentId,
        amountCents: refunds.amountCents,
        createdAt: refunds.createdAt,
      })
      .from(refunds)
      .where(
        withTenant(
          refunds,
          organizationId,
          gte(refunds.createdAt, fromDate),
          lte(refunds.createdAt, toDate),
        ),
      ),

    // Closed labor entries whose cost was realized (clocked out) in the period.
    // Only closed entries carry a non-null laborCostCents.
    db
      .select({
        id: technicianTimeEntries.id,
        serviceRequestId: technicianTimeEntries.serviceRequestId,
        laborCostCents: technicianTimeEntries.laborCostCents,
        clockOutAt: technicianTimeEntries.clockOutAt,
      })
      .from(technicianTimeEntries)
      .where(
        withTenant(
          technicianTimeEntries,
          organizationId,
          isNotNull(technicianTimeEntries.clockOutAt),
          isNotNull(technicianTimeEntries.laborCostCents),
          gte(technicianTimeEntries.clockOutAt, fromDate),
          lte(technicianTimeEntries.clockOutAt, toDate),
        ),
      ),
  ]);

  const native: JournalLine[] = [];
  const synced: JournalLine[] = [];

  for (const inv of nativeInvoiceRows) {
    const revenueCents = inv.subtotalCents + inv.taxCents;
    if (revenueCents === 0) continue;
    native.push({
      date: isoDate(inv.createdAt),
      type: "invoice",
      account: "Sales Revenue",
      memo: `Invoice ${inv.id}`,
      amountDollars: centsToDollars(revenueCents),
    });
  }

  for (const inv of syncedInvoiceRows) {
    const revenueCents = inv.subtotalCents + inv.taxCents;
    if (revenueCents === 0) continue;
    synced.push({
      date: isoDate(inv.createdAt),
      type: "invoice",
      account: "Sales Revenue",
      memo: `Invoice ${inv.id}`,
      amountDollars: centsToDollars(revenueCents),
    });
  }

  for (const pay of nativePaymentRows) {
    native.push({
      date: isoDate(pay.createdAt),
      type: "payment",
      account: "Undeposited Funds",
      memo: `Payment ${pay.id} (invoice ${pay.invoiceId})`,
      amountDollars: centsToDollars(pay.amountCents),
    });
  }

  for (const pay of syncedPaymentRows) {
    synced.push({
      date: isoDate(pay.createdAt),
      type: "payment",
      account: "Undeposited Funds",
      memo: `Payment ${pay.id} (invoice ${pay.invoiceId})`,
      amountDollars: centsToDollars(pay.amountCents),
    });
  }

  for (const ref of refundRows) {
    native.push({
      date: isoDate(ref.createdAt),
      type: "refund",
      account: "Refunds & Allowances",
      memo: `Refund ${ref.id} (payment ${ref.paymentId})`,
      amountDollars: centsToDollars(ref.amountCents),
    });
  }

  for (const lab of laborRows) {
    // clockOutAt is non-null here (filtered above); guard for the type only.
    const date = lab.clockOutAt ? isoDate(lab.clockOutAt) : isoDate(fromDate);
    native.push({
      date,
      type: "labor",
      account: "Labor Cost",
      memo: `Time entry ${lab.id} (request ${lab.serviceRequestId})`,
      amountDollars: centsToDollars(lab.laborCostCents ?? 0),
    });
  }

  return { native, synced };
}

/** RFC-4180 field escaping: quote when the value has a comma, quote, or newline. */
function csvField(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const CSV_HEADER = ["Date", "Type", "Account", "Memo", "Amount"] as const;

/** Serialize one section of lines (header already written) into CSV rows. */
function csvRows(lines: readonly JournalLine[]): string[] {
  return lines.map((line) =>
    [
      csvField(line.date),
      csvField(line.type),
      csvField(line.account),
      csvField(line.memo),
      csvField(line.amountDollars.toFixed(2)),
    ].join(","),
  );
}

/**
 * Serialize a partitioned export to CSV with two clearly separated sections:
 *
 * 1. NATIVE rows — import these into your ledger.
 * 2. SYNCED FROM FIELDPULSE rows — for reconciliation only; already booked in
 *    FieldPulse. Do NOT import alongside section 1 or money will double-count.
 *
 * Each section has its own subtotal row. A blended grand total is intentionally
 * omitted to prevent accidental double-booking.
 */
export function buildCsv(result: AccountingExportResult): string {
  const nativeTotal = result.native.reduce((s, l) => s + l.amountDollars, 0);
  const syncedTotal = result.synced.reduce((s, l) => s + l.amountDollars, 0);

  const rows: string[] = [
    CSV_HEADER.join(","),
    // ── Section 1: native rows (safe to import) ──────────────────────────────
    csvField("# NATIVE — import into your ledger"),
    ...csvRows(result.native),
    [
      csvField(""),
      csvField("subtotal"),
      csvField(""),
      csvField("Native subtotal"),
      csvField(nativeTotal.toFixed(2)),
    ].join(","),
    // ── Section 2: FieldPulse-synced rows (reconciliation only) ─────────────
    csvField(
      "# SYNCED FROM FIELDPULSE (already booked in FieldPulse — not native revenue — do NOT import)",
    ),
    ...csvRows(result.synced),
    [
      csvField(""),
      csvField("subtotal"),
      csvField(""),
      csvField("FieldPulse synced subtotal"),
      csvField(syncedTotal.toFixed(2)),
    ].join(","),
  ];

  return rows.join("\n") + "\n";
}
