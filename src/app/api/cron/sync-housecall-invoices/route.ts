/**
 * Scheduled Housecall Pro invoice reconcile via Vercel cron (parity with the
 * FieldPulse invoice cron).
 *
 *   GET — pull every HCP-connected org's job invoices into the native `invoices`
 *   table. (Vercel Cron invokes scheduled endpoints with GET.)
 *
 * DURABILITY BACKSTOP for the HCP webhook pull: a webhook-scheduled pull
 * (after()) that fails transiently marks its event processed and never retries.
 * This daily sweep re-pulls every connected org's job invoices, so a missed/
 * failed pull self-heals within one cron interval. Pulls are idempotent on
 * (org, hcpInvoiceId) and read-only (HCP stays the money authority).
 *
 * AUTH: cron secret (CRON_SECRET) via the Authorization Bearer header.
 */
import { after } from "next/server";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { db } from "@/lib/db";
import { housecallProConnections, serviceRequests } from "@/lib/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { verifyCronAuth } from "@/lib/cron-auth";
import { pullInvoicesForJob } from "@/lib/integrations/housecall-pro/invoice-sync";

export async function GET(request: Request): Promise<Response> {
  try {
    if (!verifyCronAuth(request.headers.get("Authorization"))) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    logger.info("Starting scheduled Housecall Pro invoice reconcile");

    const connections = await db
      .select({ organizationId: housecallProConnections.organizationId })
      .from(housecallProConnections)
      .where(eq(housecallProConnections.connected, true));

    let initiated = 0;

    for (const { organizationId } of connections) {
      after(async () => {
        try {
          const jobs = await db
            .select({ hcpJobId: serviceRequests.hcpJobId })
            .from(serviceRequests)
            .where(
              and(
                eq(serviceRequests.organizationId, organizationId),
                isNotNull(serviceRequests.hcpJobId),
              ),
            );

          const totals = { created: 0, updated: 0, skipped: 0, failed: 0 };
          for (const { hcpJobId } of jobs) {
            if (!hcpJobId) continue;
            const s = await pullInvoicesForJob(organizationId, hcpJobId);
            totals.created += s.created;
            totals.updated += s.updated;
            totals.skipped += s.skipped;
            totals.failed += s.failed;
          }
          logger.info(
            { organizationId, jobs: jobs.length, ...totals },
            "Cron-triggered Housecall Pro invoice reconcile complete",
          );
        } catch (error) {
          logger.error(
            { organizationId, error },
            "Cron-triggered Housecall Pro invoice reconcile failed",
          );
        }
      });

      initiated++;
    }

    logger.info(
      { totalConnections: connections.length, initiated },
      "Completed scheduling Housecall Pro invoice reconcile",
    );

    return successResponse({ initiated });
  } catch (error: unknown) {
    logger.error({ error }, "Scheduled Housecall Pro invoice reconcile failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
