/**
 * POST /api/admin/customers/[id]/erase — GDPR right-to-erasure (anonymize).
 *
 * Terminal + irreversible: scrubs all of the customer's PII and nulls the blind
 * indexes (so the contact can never be re-resolved to this row), while KEEPING
 * the de-identified financial history. Admin+ in the acting admin's own org only
 * (the dashboard layout guarantees an admin/super_admin session — technicians
 * never hold one). Tenant-scoped, rate-limited, audited (counts only, no PII).
 */
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { anonymizeCustomer } from "@/lib/admin/erasure-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:customer-erase:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid customer ID format", "INVALID_ID", 400);
    }

    const ipAddress = clientIp(request);

    const erased = await anonymizeCustomer(session.organizationId, id);
    if (!erased) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
    }

    // Record the human actor + ip (anonymizeCustomer's own audit row captures
    // the system action with counts; this one attributes it to the admin).
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "customer_erased",
      entity: "customers",
      entityId: id,
      ipAddress,
    });

    return successResponse({ ok: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to erase customer");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
