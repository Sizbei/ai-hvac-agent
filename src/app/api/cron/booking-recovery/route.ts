/**
 * Vercel Cron — AI online-booking recovery (Stage 6).
 *
 * Sweeps abandoned SMS conversations across all orgs and sends one consent-gated,
 * ledger-deduped recovery nudge each. Auth: Bearer CRON_SECRET (fail closed).
 */
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { verifyCronAuth } from "@/lib/cron-auth";
import {
  recoverAbandonedBookings,
  recoverAbandonedWebSessions,
} from "@/lib/communication/booking-recovery";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!verifyCronAuth(request.headers.get("authorization"))) {
    return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  }
  try {
    const orgs = await db.select({ id: organizations.id }).from(organizations);
    let sent = 0;
    let considered = 0;
    let webSent = 0;
    let webConsidered = 0;
    for (const org of orgs) {
      try {
        const r = await recoverAbandonedBookings(org.id);
        sent += r.sent;
        considered += r.considered;
      } catch (error) {
        logger.error({ error, organizationId: org.id }, "Recovery pass failed for org");
      }
      // Web-abandon recovery is folded into the same sweep but failure-isolated
      // from the SMS pass — a web error must never abort booking recovery.
      try {
        const w = await recoverAbandonedWebSessions(org.id);
        webSent += w.sent;
        webConsidered += w.considered;
      } catch (error) {
        logger.error({ error, organizationId: org.id }, "Web-recovery pass failed for org");
      }
    }
    return successResponse({
      orgs: orgs.length,
      considered,
      sent,
      webConsidered,
      webSent,
    });
  } catch (error) {
    logger.error({ error }, "Booking-recovery cron failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
