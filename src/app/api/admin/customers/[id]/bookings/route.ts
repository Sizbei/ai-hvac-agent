import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getCustomerBookings } from "@/lib/admin/queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * GET /api/admin/customers/[id]/bookings — every booking for one customer,
 * newest first. Sourced from service_requests (not the service_history table),
 * so imported customers show their real bookings. Powers the customers drawer.
 * Session-gated, rate-limited, tenant-scoped.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:customer-bookings:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    const bookings = await getCustomerBookings(session.organizationId, id);
    return successResponse({ bookings });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch customer bookings");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
