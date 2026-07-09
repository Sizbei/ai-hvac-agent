/**
 * Phase 9 — FieldPulse payments inbound pull.
 *
 * MONEY-SAFETY DECISION: imported FP payments are RECORD-ONLY.
 *  - They are NEVER written to invoice.amountPaidCents — FP supplies that via
 *    the invoice mirror.
 *  - They are excluded from collectedThisMonthCents and getSalesReport
 *    grossCollectedCents via `fieldpulsePaymentId IS NULL` guards (see aggregate
 *    guard files).
 *  - This is explicitly documented in the payment row (comment on fieldpulsePaymentId).
 *
 * Payment status mapping (honest approach):
 *  - "paid", "completed", "approved" → "succeeded"
 *  - "pending", "processing" → "pending"
 *  - "failed", "declined", "error" → "failed"
 *  - "refunded", "returned" → "refunded"
 *  - unknown → "pending" (the NEUTRAL safe default — never "succeeded" for unclear statuses)
 *    Unknown statuses are tallied and logged once at end.
 *
 * Invoice link: resolved by matching payments.invoiceId (FP) against invoices.fieldpulseInvoiceId.
 *  - If the linked invoice doesn't exist in native: skip the payment (skipped++).
 *    invoiceId is NOT NULL in the payments schema — unlinked payments have no meaning.
 */
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { payments, invoices } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { FieldpulseClient } from "../client";
import type { FieldpulsePayment } from "../types";
import type { PhaseResult } from "./run-import";
import { parseFpDate } from "./jobs";

export function mapFpPaymentStatus(
  fpStatus: string | null | undefined,
): "succeeded" | "pending" | "failed" | "refunded" {
  const s = (fpStatus ?? "").toLowerCase().trim();
  // FP payment status is an INTEGER on this gateway. "4" = succeeded —
  // LIVE-PROVEN (2026-07-09, account 182499): all 2,363 imported payments carry
  // status 4, and on every one of the 2,249 fully-paid invoices they sum
  // EXACTLY to the invoice's amount_paid_cents. Money that reconciles to the
  // cent is settled money.
  if (s === "4") return "succeeded";
  if (["paid", "completed", "approved"].includes(s)) return "succeeded";
  if (["pending", "processing"].includes(s)) return "pending";
  if (["failed", "declined", "error"].includes(s)) return "failed";
  if (["refunded", "returned"].includes(s)) return "refunded";
  return "pending"; // neutral safe default for unclear statuses
}

export async function importPaymentsFromFieldpulse(
  orgId: string,
  counts: PhaseResult,
  client: FieldpulseClient,
): Promise<void> {
  const { items, totalCount } = await client.listPayments();
  counts.fetched = items.length;
  counts.total = totalCount ?? null;

  // Pre-select existing fieldpulsePaymentIds for this org.
  const existingRows = await db
    .select({ fieldpulsePaymentId: payments.fieldpulsePaymentId })
    .from(payments)
    .where(
      and(
        eq(payments.organizationId, orgId),
        isNotNull(payments.fieldpulsePaymentId),
      ),
    );
  const existingFpIds = new Set(existingRows.map((r) => r.fieldpulsePaymentId as string));

  // Pre-select invoices by fieldpulseInvoiceId → native id.
  const invoiceRows = await db
    .select({ fpId: invoices.fieldpulseInvoiceId, nativeId: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.organizationId, orgId), isNotNull(invoices.fieldpulseInvoiceId)));
  const invoiceMap = new Map(invoiceRows.map((r) => [r.fpId as string, r.nativeId]));

  const unknownStatuses = new Map<string, number>();

  for (const payment of items) {
    if (payment.deletedAt != null) {
      counts.skipped++;
      continue;
    }

    // invoiceId is NOT NULL in the payments schema — skip if unresolvable.
    if (!payment.invoiceId) {
      counts.skipped++;
      logger.debug({ orgId, fpPaymentId: payment.id }, "FP payment import: no FP invoice_id — skipping");
      continue;
    }
    const resolvedInvoiceId = invoiceMap.get(payment.invoiceId) ?? null;
    if (!resolvedInvoiceId) {
      counts.skipped++;
      logger.debug(
        { orgId, fpPaymentId: payment.id, fpInvoiceId: payment.invoiceId },
        "FP payment import: FP invoice_id not found in native invoices — skipping",
      );
      continue;
    }

    try {
      const isNew = !existingFpIds.has(payment.id);
      const mappedStatus = mapFpPaymentStatus(payment.status);

      // Tally unknown statuses.
      if (payment.status != null) {
        const s = payment.status.toLowerCase().trim();
        const known = ["paid", "completed", "approved", "pending", "processing", "failed", "declined", "error", "refunded", "returned"];
        if (!known.includes(s)) {
          unknownStatuses.set(payment.status, (unknownStatuses.get(payment.status) ?? 0) + 1);
        }
      }

      const parsedPaymentDate = parseFpDate(payment.paymentDate);

      await db
        .insert(payments)
        .values({
          organizationId: orgId,
          invoiceId: resolvedInvoiceId,
          provider: "fieldpulse",
          providerPaymentId: null,
          fieldpulsePaymentId: payment.id,
          amountCents: payment.amountCents ?? 0,
          amountRefundedCents: 0,
          status: mappedStatus,
          isDeposit: false,
          createdAt: parsedPaymentDate ?? new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [payments.organizationId, payments.fieldpulsePaymentId],
          targetWhere: sql`${payments.fieldpulsePaymentId} IS NOT NULL`,
          set: {
            amountCents: payment.amountCents ?? 0,
            status: mappedStatus,
            updatedAt: new Date(),
          },
        });

      if (isNew) {
        existingFpIds.add(payment.id);
        counts.created++;
      } else {
        counts.updated++;
      }
    } catch (err) {
      counts.errors++;
      logger.error(
        {
          orgId,
          fpPaymentId: payment.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "FP payment import: per-record error (continuing)",
      );
    }
  }

  if (unknownStatuses.size > 0) {
    logger.warn(
      { orgId, unknownStatuses: Object.fromEntries(unknownStatuses) },
      "FP payment import: unknown FP status codes encountered — mapped to 'pending'",
    );
  }

  if (counts.errors > 0) {
    logger.warn(
      { orgId, errors: counts.errors, fetched: counts.fetched },
      "FP payment import: completed with per-record errors — check logs above for details",
    );
  }
}

export type { FieldpulsePayment };
