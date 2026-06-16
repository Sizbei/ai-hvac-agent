/**
 * Vercel Cron Job: Membership Maintenance Visit Generation
 *
 * ServiceTitan service-agreement parity: members on a plan with visitsPerYear>0
 * are owed scheduled maintenance visits. This cron materializes the visits
 * coming due within a forward window into real service_requests (jobType
 * 'maintenance') so they land in dispatch like any booked job.
 *
 * Idempotent: each visit is guarded by the (customerMembershipId, periodKey)
 * UNIQUE index on membership_visits, so this DAILY (Vercel Hobby) cron is safe
 * to re-run — it generates "due within N days", never "due today exactly", so a
 * missed run self-heals on the next.
 *
 * Multi-tenancy: the cron has NO session. It finds the distinct orgs with active
 * members and calls generateDueVisits per org; every write inside is scoped by
 * the row's OWN organizationId (never a global unscoped write).
 *
 * Auth: CRON_SECRET Bearer token (timing-safe, fails closed if unconfigured).
 */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerMemberships } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { verifyCronAuth } from "@/lib/cron-auth";
import { generateDueVisits } from "@/lib/admin/membership-visit-queries";

export const dynamic = "force-dynamic";

// How far ahead to materialize visits. 30 days gives the customer/dispatch lead
// time and comfortably covers a daily cron skipping a run or two.
const WITHIN_DAYS = 30;

interface GenerateVisitsCronSummary {
  readonly orgsSwept: number;
  readonly scanned: number;
  readonly generated: number;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    logger.error({}, "CRON_SECRET is not configured; refusing visit generation");
    return errorResponse("Cron endpoint not configured", "NOT_CONFIGURED", 503);
  }
  if (!verifyCronAuth(request.headers.get("authorization"))) {
    return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  }

  try {
    const now = new Date();

    // Sweep only orgs that have active members — generateDueVisits scopes every
    // read/write by the org id it's handed.
    const orgRows = await db
      .selectDistinct({ organizationId: customerMemberships.organizationId })
      .from(customerMemberships)
      .where(eq(customerMemberships.status, "active"));

    let scanned = 0;
    let generated = 0;

    for (const { organizationId } of orgRows) {
      const r = await generateDueVisits(organizationId, now, {
        withinDays: WITHIN_DAYS,
      });
      scanned += r.scanned;
      generated += r.generated;
    }

    const summary: GenerateVisitsCronSummary = {
      orgsSwept: orgRows.length,
      scanned,
      generated,
    };
    logger.info({ membershipVisits: summary }, "Membership visit generation completed");
    return successResponse(summary);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ error: errorMessage }, "Membership visit generation failed");
    return errorResponse("Visit generation failed", "INTERNAL_ERROR", 500);
  }
}
