/**
 * Vercel Cron Job: Payment Reconciliation
 *
 * Heals stranded payments left at status='pending'. takePayment records a
 * payment 'pending', charges the provider, THEN flips it to 'succeeded' +
 * advances the invoice in a non-transactional db.batch (neon-http is sequential,
 * not serializable). If that batch fails after the provider already moved money,
 * the payment is stranded — money out, no local success. This cron re-asks the
 * provider for the true charge status and completes (or fails) each stranded
 * payment, scoped by the payment row's OWN organizationId (the cron has NO
 * session, so it must never do a global unscoped update).
 *
 * Schedule: DAILY (Vercel Hobby allows daily crons only).
 * Auth: CRON_SECRET Bearer token (timing-safe, fails closed if unconfigured).
 */
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import { eq, and, lt } from "drizzle-orm";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { verifyCronAuth } from "@/lib/cron-auth";
import { reconcileOrgPendingPayments } from "@/lib/admin/invoice-queries";

export const dynamic = "force-dynamic";

const STUCK_OLDER_THAN_MS = 120000;

interface ReconcileCronSummary {
  readonly orgsSwept: number;
  readonly scanned: number;
  readonly completed: number;
  readonly failed: number;
  readonly noop: number;
}

export async function GET(request: NextRequest) {
  // Fail closed if CRON_SECRET is missing/blank — this endpoint moves money
  // state, so it must never be triggerable by an unauthenticated caller.
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    logger.error({}, "CRON_SECRET is not configured; refusing reconcile");
    return errorResponse("Cron endpoint not configured", "NOT_CONFIGURED", 503);
  }
  if (!verifyCronAuth(request.headers.get("authorization"))) {
    return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  }

  try {
    // Find the distinct orgs that currently own stuck payments — so we only sweep
    // orgs that need it. reconcileOrgPendingPayments scopes every write by the
    // org id (never a global update).
    const cutoff = new Date(Date.now() - STUCK_OLDER_THAN_MS);
    const stuckOrgRows = await db
      .selectDistinct({ organizationId: payments.organizationId })
      .from(payments)
      .where(and(eq(payments.status, "pending"), lt(payments.createdAt, cutoff)));

    let scanned = 0;
    let completed = 0;
    let failed = 0;
    let noop = 0;

    for (const { organizationId } of stuckOrgRows) {
      const r = await reconcileOrgPendingPayments(organizationId);
      scanned += r.scanned;
      completed += r.completed;
      failed += r.failed;
      noop += r.noop;
    }

    const summary: ReconcileCronSummary = {
      orgsSwept: stuckOrgRows.length,
      scanned,
      completed,
      failed,
      noop,
    };
    logger.info({ reconcile: summary }, "Payment reconciliation completed");
    return successResponse(summary);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ error: errorMessage }, "Payment reconciliation failed");
    return errorResponse("Payment reconciliation failed", "INTERNAL_ERROR", 500);
  }
}
