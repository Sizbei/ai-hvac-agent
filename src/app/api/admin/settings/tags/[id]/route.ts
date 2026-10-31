import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { updateTagType } from "@/lib/admin/tag-queries";
import { tagTypePatchSchema } from "@/lib/admin/tag-types";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:tags-update:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const { id } = await params;
    if (!UUID_REGEX.test(id)) return errorResponse("Invalid tag ID format", "INVALID_ID", 400);

    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const parsed = tagTypePatchSchema.safeParse(body.data);
    if (!parsed.success) {
      return errorResponse("Invalid tag: " + parsed.error.issues[0]?.message, "VALIDATION_ERROR", 400);
    }

    const result = await updateTagType(session.organizationId, id, parsed.data);
    if (result === null) return errorResponse("Tag not found", "NOT_FOUND", 404);
    if ("conflict" in result) {
      return errorResponse("A tag with that name already exists for this type.", "DUPLICATE_NAME", 409);
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update_tag_type",
      entity: "tag_types",
      entityId: id,
      details: JSON.stringify({ fields: Object.keys(parsed.data) }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit tag type update");
    });

    return successResponse({ tag: result });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update tag type");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
