/**
 * GET /api/platform/organizations/[id]/export — PLATFORM export of ANY org.
 *
 * Returns a decrypted, secret-free JSON snapshot of the target org as a download
 * attachment. Platform-gated (getAdminSession THEN isPlatformAdmin). Rate-limited
 * on the adminRead bucket; the action is recorded in platform_audit_log via the
 * cross-org export audit (counts only — NEVER the payload).
 */
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/authz";
import { exportOrganization, exportCounts } from "@/lib/admin/export-queries";
import { db } from "@/lib/db";
import { platformAuditLog } from "@/lib/db/schema";
import { errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isPlatformAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `platform:org-export:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid organization ID format", "INVALID_ID", 400);
    }

    const data = await exportOrganization(id);
    if (!data) {
      return errorResponse("Organization not found", "NOT_FOUND", 404);
    }

    // Cross-org action -> record in platform_audit_log (counts only, no payload).
    await db.insert(platformAuditLog).values({
      action: "org_data_exported",
      actorUserId: session.userId,
      actorEmail: session.email,
      targetOrgId: id,
      details: exportCounts(data),
    });

    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="org-${id}-export.json"`,
      },
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to export organization (platform)");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
