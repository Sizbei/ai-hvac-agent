/**
 * GET /api/admin/export — export the acting admin's OWN org data (super_admin).
 *
 * Returns a decrypted, secret-free JSON snapshot as a download attachment.
 * super_admin only (the org owner exporting their own tenant). Rate-limited on
 * the adminRead bucket and audited (counts only — NEVER the payload).
 */
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/authz";
import { exportOrganization, exportCounts } from "@/lib/admin/export-queries";
import { logAudit } from "@/lib/admin/audit";
import { errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isSuperAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `admin:export:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const data = await exportOrganization(session.organizationId);
    if (!data) {
      return errorResponse("Organization not found", "NOT_FOUND", 404);
    }

    const ipAddress = clientIp(request);
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "org_data_exported",
      entity: "organization",
      entityId: session.organizationId,
      details: JSON.stringify(exportCounts(data)),
      ipAddress,
    });

    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="org-${session.organizationId}-export.json"`,
      },
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to export organization");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
