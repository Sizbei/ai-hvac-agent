import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { generatePortalToken } from "@/lib/portal/portal-queries";
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

/**
 * Generate (or ROTATE) a customer's self-service portal link. Admin-session
 * gated. The plaintext token is returned ONCE, embedded in a /portal/<token>
 * link built from the request origin; only its hash is stored. Rotating
 * overwrites the prior hash, instantly killing any old link.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:portal-token:${session.userId}`,
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

    const token = await generatePortalToken(session.organizationId, id);
    if (!token) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
    }

    // Build the link from the request origin so it works across environments
    // without an env var (same pattern as invite links). The plaintext token is
    // returned exactly once here (never stored) for the admin to copy.
    const url = new URL(
      `/portal/${token}`,
      request.nextUrl.origin,
    ).toString();

    const ipAddress = clientIp(request);
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "generate_portal_token",
      entity: "customer",
      entityId: id,
      // id only — never the token or any PII.
      details: JSON.stringify({ rotated: true }),
      ipAddress,
    });

    return successResponse({ url }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to generate portal token");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
