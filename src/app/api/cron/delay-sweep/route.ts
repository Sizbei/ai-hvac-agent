import { NextRequest } from "next/server";
import { isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizationSettings } from "@/lib/db/schema";
import { findLateJobsForOrg, markDelayAlerted } from "@/lib/dispatch/delay-detection";
import { sendSms } from "@/lib/communication/twilio-adapter";
import { successResponse, errorResponse } from "@/lib/api-response";
import { verifyCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// A tech is flagged "behind" only after the window has been past this long, so a
// few minutes of normal slack doesn't page the dispatcher.
const GRACE_MINUTES = 15;

/** A short dispatcher alert. PII-free: reference + tech first name + the time the
 * window ended — never the customer name or address. */
function alertBody(
  referenceNumber: string,
  technicianName: string | null,
  windowEnd: Date,
): string {
  const who = technicianName ? ` (${technicianName})` : "";
  const time = windowEnd.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
  return `Running behind: ${referenceNumber}${who} — arrival window ended ${time}. The customer may be waiting.`;
}

/**
 * GET /api/cron/delay-sweep — find jobs whose technician is past their arrival
 * window and SMS the org's dispatch alert number. Sent DIRECTLY (not via the
 * daily comms queue) so the alert isn't itself delayed. Daily on Hobby; bump to
 * a few minutes on Pro for near-real-time. Cron-secret authenticated.
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

    const now = new Date();
    let alerted = 0;
    for (const org of orgs) {
      if (!org.phone) continue;
      const late = await findLateJobsForOrg(
        org.organizationId,
        now,
        GRACE_MINUTES,
      );
      for (const job of late) {
        try {
          await sendSms({
            to: org.phone,
            body: alertBody(
              job.referenceNumber,
              job.technicianName,
              job.arrivalWindowEnd,
            ),
          });
          alerted += 1;
        } catch (error) {
          // One failed send must not abort the sweep for other jobs/orgs. Do NOT
          // mark: a genuinely failed send should be retried next sweep.
          logger.error(
            { error, requestId: job.id },
            "delay-sweep: failed to send dispatcher alert",
          );
          continue;
        }
        // Mark AFTER a successful send, in its OWN try — a marker-write failure
        // must not be mislogged as a send failure (the SMS already went out). If
        // the marker write fails the next sweep may re-alert; that's the safe
        // direction (best-effort dedup, never a dropped alert).
        try {
          await markDelayAlerted(
            org.organizationId,
            job.id,
            job.arrivalWindowEnd,
          );
        } catch (error) {
          logger.error(
            { error, requestId: job.id },
            "delay-sweep: alert sent but dedup marker write failed (may re-alert next sweep)",
          );
        }
      }
    }

    return successResponse({ orgsChecked: orgs.length, alertsSent: alerted });
  } catch (error) {
    logger.error({ error }, "delay-sweep failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
