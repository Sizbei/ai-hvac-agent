/**
 * Vercel Cron — unpaid-invoice dunning.
 *
 * Sweeps every org's 'open' invoices older than the dunning window and enqueues
 * ONE consent-gated invoice_overdue reminder per invoice per 7-day bucket
 * (deduped via the outbound ledger, so a cron retry never double-sends). Each
 * org is swept by its OWN id — the cron has no session, so it never does a
 * global unscoped query. Enqueued jobs are sent by the daily
 * process-communications drain (consent + quiet-hours applied at send time).
 *
 * Schedule: DAILY (Vercel Hobby allows daily crons only).
 * Auth: CRON_SECRET Bearer token (timing-safe, fails closed if unconfigured).
 */
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { verifyCronAuth } from "@/lib/cron-auth";
import { sendOverdueInvoiceReminders } from "@/lib/communication/money-triggers";
import { enqueueWarrantyReminders } from "@/lib/admin/warranty-queries";
import { getCommsOutcomeSummary } from "@/lib/communication/observability";
import { logger } from "@/lib/logger";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!verifyCronAuth(request.headers.get("authorization"))) {
    return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  }
  try {
    const orgs = await db.select({ id: organizations.id }).from(organizations);
    let considered = 0;
    let enqueued = 0;
    let skipped = 0;
    let warrantyEnqueued = 0;
    for (const org of orgs) {
      // Warranty-expiry reminder sweep (lead-gen), FOLDED into this daily cron —
      // it ENQUEUES; the process-communications drain sends. Failure-isolated:
      // a warranty error must never abort the dunning pass for this org.
      try {
        const w = await enqueueWarrantyReminders(org.id);
        warrantyEnqueued += w.enqueued;
      } catch (error) {
        logger.error(
          { error, organizationId: org.id },
          "Warranty reminder sweep failed for org",
        );
      }

      try {
        const r = await sendOverdueInvoiceReminders(org.id);
        considered += r.considered;
        enqueued += r.enqueued;
        skipped += r.skipped;

        // Comms-outcome observability: one COUNTS-ONLY line per org per run so
        // suppression spikes / the RESEND-unset email stall are visible in logs
        // (no PII — only statuses + suppressed:<reason> tags).
        try {
          const comms = await getCommsOutcomeSummary(org.id);
          logger.info(
            {
              organizationId: org.id,
              sent: comms.sent,
              failed: comms.failed,
              pending: comms.pending,
              emailStalled: comms.emailStalled,
              suppressedByReason: comms.suppressedByReason,
            },
            "Comms outcome summary",
          );
        } catch (error) {
          logger.error(
            { error, organizationId: org.id },
            "Comms outcome summary failed for org",
          );
        }
      } catch (error) {
        logger.error(
          { error, organizationId: org.id },
          "Dunning pass failed for org",
        );
      }
    }
    return successResponse({
      orgs: orgs.length,
      considered,
      enqueued,
      skipped,
      warrantyEnqueued,
    });
  } catch (error) {
    // Surface a fully-failed dunning sweep to error tracking (inert without a DSN).
    Sentry.captureException(error, { tags: { cron: "dunning" } });
    logger.error({ error }, "Dunning cron failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
