/**
 * Scheduled Fieldpulse invoice reconcile via Vercel cron.
 *
 *   GET — pull every Fieldpulse-connected org's job invoices into the native
 *   `invoices` table. (Vercel Cron invokes scheduled endpoints with GET.)
 *
 * This is the DURABILITY BACKSTOP for the invoice-webhook pull: a webhook-
 * scheduled pull (after()) that fails transiently marks its event processed and
 * never retries on its own. This daily sweep re-pulls every connected org's job
 * invoices, so a missed/failed pull self-heals within one cron interval. Pulls
 * are idempotent on (org, fieldpulseInvoiceId) and read-only (Fieldpulse stays
 * the money authority), so re-running is safe.
 *
 * AUTH: cron secret (CRON_SECRET) via the Authorization Bearer header.
 */
import { after } from "next/server";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { db } from "@/lib/db";
import { fieldpulseConnections, serviceRequests } from "@/lib/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { verifyCronAuth } from "@/lib/cron-auth";
import { pullInvoicesForJob } from "@/lib/integrations/fieldpulse/invoice-sync";

export async function GET(request: Request): Promise<Response> {
  try {
    if (!verifyCronAuth(request.headers.get("Authorization"))) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    logger.info("Starting scheduled Fieldpulse invoice reconcile");

    const connections = await db
      .select({ organizationId: fieldpulseConnections.organizationId })
      .from(fieldpulseConnections)
      .where(eq(fieldpulseConnections.connected, true));

    let initiated = 0;

    for (const { organizationId } of connections) {
      // Each org's sweep runs in the background so the cron returns fast; a
      // detached promise would be frozen on Vercel, so use after().
      after(async () => {
        try {
          // Org-scoped: only this org's jobs (defense-in-depth + index use).
          const jobs = await db
            .select({ fieldpulseJobId: serviceRequests.fieldpulseJobId })
            .from(serviceRequests)
            .where(
              and(
                eq(serviceRequests.organizationId, organizationId),
                isNotNull(serviceRequests.fieldpulseJobId),
              ),
            );

          const totals = { created: 0, updated: 0, skipped: 0, failed: 0 };
          for (const { fieldpulseJobId } of jobs) {
            if (!fieldpulseJobId) continue;
            const s = await pullInvoicesForJob(organizationId, fieldpulseJobId);
            totals.created += s.created;
            totals.updated += s.updated;
            totals.skipped += s.skipped;
            totals.failed += s.failed;
          }
          logger.info(
            { organizationId, jobs: jobs.length, ...totals },
            "Cron-triggered Fieldpulse invoice reconcile complete",
          );
        } catch (error) {
          logger.error(
            { organizationId, error },
            "Cron-triggered Fieldpulse invoice reconcile failed",
          );
        }
      });

      initiated++;
    }

    logger.info(
      { totalConnections: connections.length, initiated },
      "Completed scheduling Fieldpulse invoice reconcile",
    );

    return successResponse({ initiated });
  } catch (error: unknown) {
    logger.error({ error }, "Scheduled Fieldpulse invoice reconcile failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
