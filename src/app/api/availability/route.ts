import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { customerSessions } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { isSameOriginRequest } from "@/lib/session-csrf";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import {
  getOpenAvailability,
  businessDaysFrom,
  businessTodayIso,
  AVAILABILITY_TIME_ZONE,
} from "@/lib/admin/availability-queries";
import { logger } from "@/lib/logger";

/**
 * GET /api/availability — PUBLIC-ish customer-facing open-window read.
 *
 * Given a start business-day (default: today, Eastern) and a day count, returns
 * the OPEN appointment windows = technician availability MINUS already-booked
 * windows, aggregated across techs into bookable morning/afternoon/evening bands
 * (in America/New_York). Consumed by the customer chat/widget intake to offer
 * REAL open slots instead of "we'll confirm the time".
 *
 * SECURITY POSTURE (this is consumed by the embeddable widget, so it is
 * "public-ish" — reachable by any visitor with a session, never authenticated as
 * an admin):
 *  - SESSION-SCOPED: the org comes from the visitor's customer session row, never
 *    a client-supplied org id, so a caller can only read THEIR org's availability.
 *  - RATE-LIMITED: per-IP sessionAction bucket (a read; same bucket the other
 *    customer session actions use) caps scraping.
 *  - CSRF/same-origin: this is a GET (no state change, "simple" request), so we
 *    reject only when an Origin header is PRESENT and cross-origin — a same-origin
 *    fetch may omit Origin and must still succeed. (Unlike the POST guards, we do
 *    NOT deny an absent Origin here, or every legitimate same-origin GET 403s.)
 *  - INPUT VALIDATED: start date + day count are zod-parsed and bounded.
 *  - PII-FREE OUTPUT: returns ONLY window + capacity/available counts — never a
 *    technician name or id (computeOpenWindows aggregates to counts).
 *
 * HCP SEAM: getOpenAvailability reads through the SchedulingSource, so an
 * HCP-backed source becomes the source of truth here with no route change.
 */

// At most a fortnight of days per call — enough to offer next-business-day +
// the following week's slots, bounded so a caller can't request an unbounded
// range. Default 7 (a week) when the count is omitted.
const MAX_DAYS = 14;
const DEFAULT_DAYS = 7;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z
  .object({
    // Optional start day (business-tz YYYY-MM-DD); defaults to today (Eastern).
    start: z
      .string()
      .regex(ISO_DAY, "start must be YYYY-MM-DD")
      .optional(),
    // Optional day count [1, MAX_DAYS]; defaults to a week.
    days: z.coerce.number().int().min(1).max(MAX_DAYS).optional(),
  })
  .strict();

export async function GET(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const rateCheck = slidingWindow(
    `availability:${ip}`,
    RATE_LIMITS.sessionAction.maxRequests,
    RATE_LIMITS.sessionAction.windowMs,
  );
  if (!rateCheck.allowed) {
    return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
  }

  // Same-origin for a GET: reject ONLY when an Origin header is present and it's
  // cross-origin (a deliberate cross-site read of capacity counts). A legitimate
  // same-origin fetch may omit Origin, so absence is allowed here (the POST
  // guards deny absence; a read has no state-changing CSRF risk to justify it).
  const originHeader = request.headers.get("origin");
  if (originHeader && !isSameOriginRequest(request)) {
    return errorResponse("Cross-origin request rejected", "FORBIDDEN_ORIGIN", 403);
  }

  try {
    const token = await getSessionToken();
    if (!token) {
      return errorResponse("No session found", "NO_SESSION", 401);
    }

    const [session] = await db
      .select({ organizationId: customerSessions.organizationId })
      .from(customerSessions)
      .where(eq(customerSessions.token, token))
      .limit(1);

    if (!session) {
      return errorResponse("Session not found", "SESSION_NOT_FOUND", 404);
    }

    // Validate query params. zod parse over the searchParams object.
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      start: url.searchParams.get("start") ?? undefined,
      days: url.searchParams.get("days") ?? undefined,
    });
    if (!parsed.success) {
      return errorResponse(
        "Invalid availability query",
        "VALIDATION_FAILED",
        400,
      );
    }

    const startDay = parsed.data.start ?? businessTodayIso(new Date());
    const dayCount = parsed.data.days ?? DEFAULT_DAYS;
    const days = businessDaysFrom(startDay, dayCount);

    const availability = await getOpenAvailability(
      session.organizationId,
      days,
    );

    return successResponse({
      ...availability,
      // The fixed business timezone the bands are expressed in, so the client
      // never re-interprets them in the browser's local zone.
      timeZone: AVAILABILITY_TIME_ZONE,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to compute availability");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
