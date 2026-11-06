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
 * PII: memos carry NON-SENSITIVE references only (the #XXXXXXXX refs the app
 * shows, plus the payment method enum) and the Reference column the full row
 * id — never customer names, emails, addresses, or free-text. The exported
 * FILE does contain amounts, so the route that serves it is super_admin-gated.
 *
 * CSV shape (QuickBooks-importable): one header row, one row per transaction,
 * no comment or subtotal rows. Amounts are signed — money in (invoice,
 * payment) positive, money out (refund) negative; labor is a positive cost on
 * the Labor Cost account. An invoice posts its subtotal to Sales Revenue and
 * its tax, on a separate row, to Sales Tax Payable (tax is owed to the state,
 * not earned). An `Import` column says which rows belong in your ledger
 * ("Yes") and which are already booked in FieldPulse/HCP ("No — …").
 *
 * DATES are the org's business-time-zone calendar day (a payment at 8 pm
 * Eastern on Nov 5 is Nov 5, not UTC's Nov 6), and rows are sorted by date
 * within each section.
 */
import { and, or, eq, gte, lte, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  invoices,
  payments,
  refunds,
  technicianTimeEntries,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { invoiceRef } from "@/lib/admin/invoice-collectible";
import { BUSINESS_TIME_ZONE } from "@/lib/admin/calendar-time";
import { dateInZone } from "@/lib/admin/zoned-date";

/** QBO-style account names the journal posts against. */
export type AccountName =
  | "Sales Revenue"
  | "Sales Tax Payable"
  | "Undeposited Funds"
  | "Refunds & Allowances"
  | "Labor Cost";

export type JournalLineType = "invoice" | "tax" | "payment" | "refund" | "labor";

export interface JournalLine {
  /** ISO date (YYYY-MM-DD) the line is dated on. */
  readonly date: string;
  readonly type: JournalLineType;
  /** QBO account the amount posts to. */
  readonly account: AccountName;
  /** Full id of the source row (invoice/payment/refund/time entry). */
  readonly ref: string;
  /** Non-sensitive memo — app refs only, never customer PII. */
  readonly memo: string;
  /** Amount in decimal DOLLARS (cents/100). Signed: refunds are negative,
   * everything else positive. */
  readonly amountDollars: number;
  /** External system this row was mirrored from. Undefined for native rows. */
  readonly source?: "fieldpulse" | "housecall";
}

export interface AccountingExportPeriod {
  readonly fromDate: Date;
  readonly toDate: Date;
  /** IANA zone the line dates are written in (the org's business zone). */
  readonly timeZone?: string;
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

/**
 * An invoice's journal rows: subtotal → Sales Revenue, tax → Sales Tax
 * Payable (its own row so tax collected is never booked as income). Zero
 * amounts are left out.
 */
function invoiceLines(
  inv: { readonly id: string; readonly subtotalCents: number; readonly taxCents: number },
  date: string,
  source?: JournalLine["source"],
): JournalLine[] {
  const lines: JournalLine[] = [];
  const sourced = source ? { source } : {};
  if (inv.subtotalCents !== 0) {
    lines.push({
      date,
      type: "invoice",
      account: "Sales Revenue",
      ref: inv.id,
      memo: `Invoice ${invoiceRef(inv.id)}`,
      amountDollars: centsToDollars(inv.subtotalCents),
      ...sourced,
    });
  }
  if (inv.taxCents !== 0) {
    lines.push({
      date,
      type: "tax",
      account: "Sales Tax Payable",
      ref: inv.id,
      memo: `Sales tax on invoice ${invoiceRef(inv.id)}`,
      amountDollars: centsToDollars(inv.taxCents),
      ...sourced,
    });
  }
  return lines;
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
  const timeZone = period.timeZone ?? BUSINESS_TIME_ZONE;
  const isoDate = (d: Date): string => dateInZone(d, timeZone);

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

    // Synced invoices (FP- or HCP-mirrored) — listed separately, NOT imported to ledger.
    // Filtered and dated by coalesce(issuedAt, createdAt) — issuedAt is the real
    // source-system invoice date; createdAt is only when WE imported the row
    // (schema.ts:2769-2774). Matches /admin/invoices and /admin/operations.
    db
      .select({
        id: invoices.id,
        subtotalCents: invoices.subtotalCents,
        taxCents: invoices.taxCents,
        createdAt: invoices.createdAt,
        issuedAt: invoices.issuedAt,
        fieldpulseInvoiceId: invoices.fieldpulseInvoiceId,
        hcpInvoiceId: invoices.hcpInvoiceId,
      })
      .from(invoices)
      .where(
        withTenant(
          invoices,
          organizationId,
          or(isNotNull(invoices.fieldpulseInvoiceId), isNotNull(invoices.hcpInvoiceId))!,
          gte(sql`coalesce(${invoices.issuedAt}, ${invoices.createdAt})`, fromDate),
          lte(sql`coalesce(${invoices.issuedAt}, ${invoices.createdAt})`, toDate),
        ),
      ),

    // Native payments (not FP-synced) -> cash received.
    db
      .select({
        id: payments.id,
        invoiceId: payments.invoiceId,
        amountCents: payments.amountCents,
        method: payments.method,
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
        method: payments.method,
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
    // Refunds are always native; no FP mirror for this table. The payment's
    // invoice id names the refund by the invoice number the office knows.
    db
      .select({
        id: refunds.id,
        paymentId: refunds.paymentId,
        invoiceId: payments.invoiceId,
        amountCents: refunds.amountCents,
        createdAt: refunds.createdAt,
      })
      .from(refunds)
      .leftJoin(
        payments,
        and(
          eq(payments.id, refunds.paymentId),
          eq(payments.organizationId, refunds.organizationId),
        ),
      )
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
    native.push(...invoiceLines(inv, isoDate(inv.createdAt)));
  }

  for (const inv of syncedInvoiceRows) {
    // issuedAt is the real source-system invoice date; createdAt is only
    // when WE imported the row (see the query comment above).
    const effectiveDate = inv.issuedAt ?? inv.createdAt;
    synced.push(
      ...invoiceLines(
        inv,
        isoDate(effectiveDate),
        inv.fieldpulseInvoiceId ? "fieldpulse" : "housecall",
      ),
    );
  }

  for (const pay of nativePaymentRows) {
    native.push({
      date: isoDate(pay.createdAt),
      type: "payment",
      account: "Undeposited Funds",
      ref: pay.id,
      memo: paymentMemo(pay.invoiceId, pay.method),
      amountDollars: centsToDollars(pay.amountCents),
    });
  }

  for (const pay of syncedPaymentRows) {
    synced.push({
      date: isoDate(pay.createdAt),
      type: "payment",
      account: "Undeposited Funds",
      ref: pay.id,
      memo: paymentMemo(pay.invoiceId, pay.method),
      amountDollars: centsToDollars(pay.amountCents),
      // HCP never writes to `payments` (no HCP payment mirror) — every synced
      // payment row is FieldPulse-sourced.
      source: "fieldpulse",
    });
  }

  for (const ref of refundRows) {
    native.push({
      date: isoDate(ref.createdAt),
      type: "refund",
      account: "Refunds & Allowances",
      ref: ref.id,
      memo: ref.invoiceId
        ? `Refund on invoice ${invoiceRef(ref.invoiceId)}`
        : `Refund on payment ${invoiceRef(ref.paymentId)}`,
      // Money out: negative, so a column sum nets correctly.
      amountDollars: -centsToDollars(ref.amountCents),
    });
  }

  for (const lab of laborRows) {
    // A $0 labor row (no rate on file) is noise in a ledger import.
    if (!lab.laborCostCents) continue;
    // clockOutAt is non-null here (filtered above); guard for the type only.
    const date = lab.clockOutAt ? isoDate(lab.clockOutAt) : isoDate(fromDate);
    native.push({
      date,
      type: "labor",
      account: "Labor Cost",
      ref: lab.id,
      memo: lab.serviceRequestId ? `Labor on request ${invoiceRef(lab.serviceRequestId)}` : 'Labor',
      amountDollars: centsToDollars(lab.laborCostCents ?? 0),
    });
  }

  return { native: sortByDate(native), synced: sortByDate(synced) };
}

/** Oldest first; same-day rows keep their order (invoice before its tax). */
function sortByDate(lines: readonly JournalLine[]): JournalLine[] {
  return [...lines].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** RFC-4180 field escaping: quote when the value has a comma, quote, or newline. */
function csvField(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const CSV_HEADER = ["Date", "Type", "Account", "Reference", "Memo", "Amount", "Import"] as const;

/** "Payment on invoice #AFA28E5D (check)". */
function paymentMemo(invoiceId: string | null, method: string): string {
  return invoiceId ? `Payment on invoice ${invoiceRef(invoiceId)} (${method})` : `Payment (${method})`;
}

/**
 * The Import column: native rows go in your ledger; mirrored rows are already
 * booked in their source system — importing them double-counts the money.
 */
function importLabel(line: JournalLine): string {
  if (!line.source) return "Yes";
  return line.source === "fieldpulse" ? "No — already in FieldPulse" : "No — already in HCP";
}

function csvRow(line: JournalLine): string {
  return [
    csvField(line.date),
    csvField(line.type),
    csvField(line.account),
    csvField(line.ref),
    csvField(line.memo),
    csvField(line.amountDollars.toFixed(2)),
    csvField(importLabel(line)),
  ].join(",");
}

/**
 * Serialize a partitioned export to a QuickBooks-importable CSV: one header,
 * then native rows (Import = Yes), then mirrored rows (Import = No — …). No
 * comment or subtotal rows (they break an import, and a sum across invoices,
 * payments and labor means nothing); filter on Import before importing.
 */
export function buildCsv(result: AccountingExportResult): string {
  const rows: string[] = [
    CSV_HEADER.join(","),
    ...result.native.map(csvRow),
    ...result.synced.map(csvRow),
  ];
  return rows.join("\n") + "\n";
}
