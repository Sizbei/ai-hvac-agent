import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import {
  getOpenAvailability,
  businessDaysFrom,
  businessTodayIso,
  AVAILABILITY_TIME_ZONE,
} from "@/lib/admin/availability-queries";
import { isRealIsoDate } from "@/lib/admin/calendar-time";
import { logger } from "@/lib/logger";

// Same bounds as the customer-facing /api/availability.
const MAX_DAYS = 14;
const DEFAULT_DAYS = 7;

const querySchema = z
  .object({
    start: z
      .string()
      .refine(isRealIsoDate, "start must be a real YYYY-MM-DD date")
      .optional(),
    days: z.coerce.number().int().min(1).max(MAX_DAYS).optional(),
  })
  .strict();

/**
 * GET /api/admin/requests/availability — open arrival-window bands for the
 * office "New request" dialog. Admin-session wrapper over getOpenAvailability:
 * the org comes from the admin session; returns the same day → band shape
 * (capacity / available counts, no technician ids) as /api/availability.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:requests-availability:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const params = request.nextUrl.searchParams;
    const parsed = querySchema.safeParse({
      start: params.get("start") ?? undefined,
      days: params.get("days") ?? undefined,
    });
    if (!parsed.success) {
      return errorResponse("Invalid availability query", "VALIDATION_ERROR", 400);
    }

    const startDay = parsed.data.start ?? businessTodayIso(new Date());
    const days = businessDaysFrom(startDay, parsed.data.days ?? DEFAULT_DAYS);
    const availability = await getOpenAvailability(session.organizationId, days);

    return successResponse({ ...availability, timeZone: AVAILABILITY_TIME_ZONE });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to compute admin availability");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
