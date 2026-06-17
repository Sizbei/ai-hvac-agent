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
import { eq, gte, lte, isNotNull } from "drizzle-orm";
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

/** Integer cents -> decimal dollars, rounded to 2 dp (no float drift). */
function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

/** YYYY-MM-DD in UTC (stable, locale-independent — accounting wants a date). */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the period journal for an org: invoice (revenue), payment (cash
 * received), refund (contra), and labor-cost lines. All reads tenant-scoped and
 * period-scoped by the row's createdAt (labor by clockOutAt — when the cost is
 * realized). Money converted cents->dollars here only.
 */
export async function getAccountingExport(
  organizationId: string,
  period: AccountingExportPeriod,
): Promise<JournalLine[]> {
  const { fromDate, toDate } = period;

  const [invoiceRows, paymentRows, refundRows, laborRows] = await Promise.all([
    // Invoices created in the period -> revenue recognized (credit Sales Revenue).
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
          gte(invoices.createdAt, fromDate),
          lte(invoices.createdAt, toDate),
        ),
      ),

    // Succeeded payments in the period -> cash received (debit Undeposited Funds).
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
          gte(payments.createdAt, fromDate),
          lte(payments.createdAt, toDate),
        ),
      ),

    // Refunds issued in the period -> contra (Refunds & Allowances).
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

  const lines: JournalLine[] = [];

  for (const inv of invoiceRows) {
    // Revenue = subtotal + tax (the full invoiced amount). Skip zero-value rows.
    const revenueCents = inv.subtotalCents + inv.taxCents;
    if (revenueCents === 0) continue;
    lines.push({
      date: isoDate(inv.createdAt),
      type: "invoice",
      account: "Sales Revenue",
      memo: `Invoice ${inv.id}`,
      amountDollars: centsToDollars(revenueCents),
    });
  }

  for (const pay of paymentRows) {
    lines.push({
      date: isoDate(pay.createdAt),
      type: "payment",
      account: "Undeposited Funds",
      memo: `Payment ${pay.id} (invoice ${pay.invoiceId})`,
      amountDollars: centsToDollars(pay.amountCents),
    });
  }

  for (const ref of refundRows) {
    lines.push({
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
    lines.push({
      date,
      type: "labor",
      account: "Labor Cost",
      memo: `Time entry ${lab.id} (request ${lab.serviceRequestId})`,
      amountDollars: centsToDollars(lab.laborCostCents ?? 0),
    });
  }

  return lines;
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

/**
 * Serialize a journal to a QBO-importable CSV string. Amount is decimal dollars
 * with 2 fixed places. Header row + one row per line.
 */
export function buildCsv(journal: readonly JournalLine[]): string {
  const rows = [CSV_HEADER.join(",")];
  for (const line of journal) {
    rows.push(
      [
        csvField(line.date),
        csvField(line.type),
        csvField(line.account),
        csvField(line.memo),
        csvField(line.amountDollars.toFixed(2)),
      ].join(","),
    );
  }
  // Trailing newline so the file ends cleanly (most importers tolerate either).
  return rows.join("\n") + "\n";
}
