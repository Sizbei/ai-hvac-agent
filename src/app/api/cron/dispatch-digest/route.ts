import { NextRequest } from "next/server";
import { isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizationSettings } from "@/lib/db/schema";
import { getDispatchOutcomeRollup } from "@/lib/admin/dispatch-rollup";
import { sendSms } from "@/lib/communication/twilio-adapter";
import { successResponse, errorResponse } from "@/lib/api-response";
import { verifyCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Minimum decisions in EACH window before a collapse is trustworthy — guards the
// empty/near-empty denominator so a slow week can't page the dispatcher.
const MIN_DECISIONS = 20;
// This week's commit rate below this fraction of the trailing-28-day rate = collapse.
const COLLAPSE_FRACTION = 0.5;
const WEEK_DAYS = 7;
const TRAILING_DAYS = 28;

/** A short dispatch-health alert. PII-free: rates + counts only. */
function alertBody(weekRate: number, trailingRate: number): string {
  return `Dispatch alert: auto-commit rate fell to ${Math.round(
    weekRate * 100,
  )}% this week (28-day baseline ${Math.round(
    trailingRate * 100,
  )}%). Check geocoding/signals or a recent weight change.`;
}

/**
 * GET /api/cron/dispatch-digest — weekly canary. For each org with a dispatch
 * alert number, compare this week's commit rate to the trailing-28-day rate
 * (over real + shadow decisions together) and SMS a collapse alert. Cron-secret
 * authenticated; per-org try/catch so one org's config can't abort the run
 * (sendSms THROWS without TWILIO_PHONE_NUMBER).
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    return errorResponse("Cron endpoint not configured", "NOT_CONFIGURED", 503);
  }
  if (!verifyCronAuth(request.headers.get("authorization"))) {
    return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  }

  try {
    // Only orgs that have opted in by setting a dispatch alert number.
    const orgs = await db
      .select({
        organizationId: organizationSettings.organizationId,
        phone: organizationSettings.dispatchAlertPhone,
      })
      .from(organizationSettings)
      .where(isNotNull(organizationSettings.dispatchAlertPhone));

    let alerted = 0;
    for (const org of orgs) {
      try {
        const [week, trailing] = await Promise.all([
          getDispatchOutcomeRollup(org.organizationId, WEEK_DAYS),
          getDispatchOutcomeRollup(org.organizationId, TRAILING_DAYS),
        ]);

        // Need enough signal in BOTH windows, and non-null rates, to judge a collapse.
        if (
          week.real.total + week.shadow.total < MIN_DECISIONS ||
          trailing.real.total + trailing.shadow.total < MIN_DECISIONS ||
          week.commitRate === null ||
          trailing.commitRate === null
        ) {
          continue;
        }

        const collapsed =
          week.commitRate < COLLAPSE_FRACTION * trailing.commitRate;
        if (!collapsed) continue;

        if (!org.phone) {
          // Log-only when no alert phone (can't happen given the WHERE, but keep
          // the guard so a future query change fails safe).
          logger.info(
            { organizationId: org.organizationId },
            "dispatch-digest: collapse detected but no alert phone",
          );
          continue;
        }

        await sendSms({
          to: org.phone,
          body: alertBody(week.commitRate, trailing.commitRate),
        });
        alerted += 1;
      } catch (error) {
        // One org's config/send failure must not abort the sweep. sendSms throws
        // when TWILIO_PHONE_NUMBER is unset — log and continue.
        logger.error(
          { error, organizationId: org.organizationId },
          "dispatch-digest: failed to evaluate/alert for org",
        );
        continue;
      }
    }

    return successResponse({ orgsChecked: orgs.length, alertsSent: alerted });
  } catch (error) {
    logger.error({ error }, "dispatch-digest failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
