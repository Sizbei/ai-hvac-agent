import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import {
  updateCustomFaq,
  deleteCustomFaq,
} from "@/lib/admin/org-config-queries";
import { customFaqInputSchema } from "@/lib/admin/org-config-types";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid FAQ ID", "INVALID_ID", 400);
    }

    const body: unknown = await request.json();
    // Partial update — all fields optional.
    const parsed = customFaqInputSchema.partial().safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid FAQ: " + parsed.error.issues[0]?.message,
        "VALIDATION_ERROR",
        400,
      );
    }

    const faq = await updateCustomFaq(session.organizationId, id, parsed.data);
    if (!faq) {
      return errorResponse("FAQ not found", "NOT_FOUND", 404);
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update_custom_faq",
      entity: "custom_faqs",
      entityId: id,
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit FAQ update");
    });

    return successResponse({ faq });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update custom FAQ");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid FAQ ID", "INVALID_ID", 400);
    }

    const deleted = await deleteCustomFaq(session.organizationId, id);
    if (!deleted) {
      return errorResponse("FAQ not found", "NOT_FOUND", 404);
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "delete_custom_faq",
      entity: "custom_faqs",
      entityId: id,
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit FAQ deletion");
    });

    return successResponse({ deleted: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to delete custom FAQ");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
