import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { updateContact, deleteContact } from "@/lib/admin/contact-queries";
import { contactPatchSchema } from "@/lib/admin/contact-types";
import { logAudit } from "@/lib/admin/audit";
import { isUuid } from "@/lib/validation/uuid";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string; cid: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:customer-contact-update:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id, cid } = await params;
    if (!isUuid(id) || !isUuid(cid)) {
      return errorResponse("Not found", "NOT_FOUND", 404);
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }
    const parsed = contactPatchSchema.safeParse(body.data);
    if (!parsed.success) {
      return errorResponse(
        "Invalid contact: " + parsed.error.issues[0]?.message,
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await updateContact(session.organizationId, id, cid, parsed.data);
    if (result === null) {
      return errorResponse("Contact not found", "NOT_FOUND", 404);
    }
    if ("reason" in result) {
      return errorResponse(
        "That location doesn't belong to this customer.",
        "VALIDATION_ERROR",
        400,
      );
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update_contact",
      entity: "customer_contacts",
      entityId: cid,
      details: JSON.stringify({ customerId: id }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit update_contact");
    });

    return successResponse({ contact: result });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update customer contact");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:customer-contact-delete:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id, cid } = await params;
    if (!isUuid(id) || !isUuid(cid)) {
      return errorResponse("Not found", "NOT_FOUND", 404);
    }

    const deleted = await deleteContact(session.organizationId, id, cid);
    if (!deleted) {
      return errorResponse("Contact not found", "NOT_FOUND", 404);
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "delete_contact",
      entity: "customer_contacts",
      entityId: cid,
      details: JSON.stringify({ customerId: id }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit delete_contact");
    });

    return successResponse({ id: cid });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to delete customer contact");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
