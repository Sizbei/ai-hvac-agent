import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getAdminSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { listCustomerLocations } from "@/lib/admin/location-queries";
import { isUuid } from "@/lib/validation/uuid";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:customer-locations:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!isUuid(id)) {
      return errorResponse("Not found", "NOT_FOUND", 404);
    }

    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(withTenant(customers, session.organizationId, eq(customers.id, id)))
      .limit(1);
    if (!customer) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
    }

    const locations = await listCustomerLocations(session.organizationId, id);
    return successResponse({ locations });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list customer locations");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
