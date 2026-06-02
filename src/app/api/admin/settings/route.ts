import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getOrgConfig, updateOrgConfig } from "@/lib/admin/org-config-queries";
import { orgConfigUpdateSchema } from "@/lib/admin/org-config-types";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const config = await getOrgConfig(session.organizationId);
    return successResponse({ config });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch org config");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const body: unknown = await request.json();
    const parsed = orgConfigUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid settings: " + parsed.error.issues[0]?.message,
        "VALIDATION_ERROR",
        400,
      );
    }

    const config = await updateOrgConfig(session.organizationId, parsed.data);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update_settings",
      entity: "organization_settings",
      entityId: session.organizationId,
      // Record which fields changed (not the values — could contain PII-ish data).
      details: JSON.stringify({ fields: Object.keys(parsed.data) }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit settings update");
    });

    return successResponse({ config });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update org config");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
