import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import {
  getCustomerById,
  addEquipment,
  addNote,
  addFollowUp,
  updateCustomerContact,
  completeFollowUp,
  deleteCustomer,
} from "@/lib/admin/crm-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;
    const customer = await getCustomerById(session.organizationId, id);

    if (!customer) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
    }

    return successResponse(customer);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch customer");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid customer ID format", "INVALID_ID", 400);
    }

    const ipAddress = request.headers.get("x-forwarded-for") ?? "unknown";

    // Every POST action here mutates state (equipment/note/follow-up/contact),
    // so rate-limit the whole handler like DELETE does — shared admin-mutation
    // bucket keyed by the acting admin.
    const rateCheck = slidingWindow(
      `admin:customer-post:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body = (await request.json()) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";

    switch (action) {
      case "add_equipment": {
        const equipmentType =
          typeof body.equipmentType === "string" ? body.equipmentType : "";
        if (!equipmentType) {
          return errorResponse(
            "Equipment type is required",
            "VALIDATION_ERROR",
            400,
          );
        }
        await addEquipment(session.organizationId, id, {
          equipmentType,
          make: typeof body.make === "string" ? body.make : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          serialNumber:
            typeof body.serialNumber === "string"
              ? body.serialNumber
              : undefined,
          installDate:
            typeof body.installDate === "string"
              ? body.installDate
              : undefined,
          warrantyExpiration:
            typeof body.warrantyExpiration === "string"
              ? body.warrantyExpiration
              : undefined,
          locationInHome:
            typeof body.locationInHome === "string"
              ? body.locationInHome
              : undefined,
          notes: typeof body.notes === "string" ? body.notes : undefined,
        });
        return successResponse({ ok: true }, 201);
      }

      case "add_note": {
        const content =
          typeof body.content === "string" ? body.content.trim() : "";
        if (!content) {
          return errorResponse(
            "Content is required",
            "VALIDATION_ERROR",
            400,
          );
        }
        await addNote(session.organizationId, id, session.userId, {
          content,
          noteType:
            typeof body.noteType === "string" ? body.noteType : undefined,
        });
        return successResponse({ ok: true }, 201);
      }

      case "add_follow_up": {
        const reason =
          typeof body.reason === "string" ? body.reason.trim() : "";
        const dueDate =
          typeof body.dueDate === "string" ? body.dueDate : "";
        if (!reason || !dueDate) {
          return errorResponse(
            "Reason and due date are required",
            "VALIDATION_ERROR",
            400,
          );
        }
        await addFollowUp(session.organizationId, id, {
          reason,
          dueDate,
          assignedTo:
            typeof body.assignedTo === "string" ? body.assignedTo : undefined,
        });
        return successResponse({ ok: true }, 201);
      }

      case "update_contact": {
        // Build a patch from only the keys actually present on the body.
        // `null` clears a field; an absent key leaves it untouched. `name`
        // can't be cleared (NOT NULL) so we only accept a non-empty string.
        const patch: {
          name?: string;
          phone?: string | null;
          email?: string | null;
          address?: string | null;
          propertyType?: string | null;
          propertySqft?: number | null;
          notes?: string | null;
        } = {};

        if (typeof body.name === "string" && body.name.trim().length > 0) {
          patch.name = body.name.trim();
        }
        if ("phone" in body) {
          patch.phone =
            typeof body.phone === "string" && body.phone.trim().length > 0
              ? body.phone.trim()
              : null;
        }
        if ("email" in body) {
          patch.email =
            typeof body.email === "string" && body.email.trim().length > 0
              ? body.email.trim()
              : null;
        }
        if ("address" in body) {
          patch.address =
            typeof body.address === "string" && body.address.trim().length > 0
              ? body.address.trim()
              : null;
        }
        if ("propertyType" in body) {
          patch.propertyType =
            typeof body.propertyType === "string" &&
            body.propertyType.trim().length > 0
              ? body.propertyType.trim()
              : null;
        }
        if ("propertySqft" in body) {
          patch.propertySqft =
            typeof body.propertySqft === "number" &&
            Number.isFinite(body.propertySqft) &&
            body.propertySqft >= 0
              ? Math.floor(body.propertySqft)
              : null;
        }
        if ("notes" in body) {
          patch.notes =
            typeof body.notes === "string" && body.notes.trim().length > 0
              ? body.notes.trim()
              : null;
        }

        const result = await updateCustomerContact(
          session.organizationId,
          id,
          patch,
          { userId: session.userId, ipAddress },
        );

        if (!result.ok) {
          if (result.reason === "not_found") {
            return errorResponse("Customer not found", "NOT_FOUND", 404);
          }
          return errorResponse(
            "Another customer already uses that email or phone",
            "CONTACT_CONFLICT",
            409,
          );
        }
        return successResponse({ ok: true });
      }

      case "complete_follow_up": {
        const followUpId =
          typeof body.followUpId === "string" ? body.followUpId : "";
        if (!UUID_REGEX.test(followUpId)) {
          return errorResponse(
            "Valid follow-up ID is required",
            "VALIDATION_ERROR",
            400,
          );
        }
        const done = await completeFollowUp(
          session.organizationId,
          followUpId,
          { userId: session.userId },
        );
        if (!done) {
          return errorResponse(
            "Follow-up not found or already completed",
            "NOT_FOUND",
            404,
          );
        }
        return successResponse({ ok: true });
      }

      default:
        return errorResponse("Unknown action", "INVALID_ACTION", 400);
    }
  } catch (error: unknown) {
    logger.error({ error }, "Failed to perform customer action");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const ipAddress = request.headers.get("x-forwarded-for") ?? "unknown";
    const rateCheck = slidingWindow(
      `admin:delete:${session.userId}`,
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

    const deleted = await deleteCustomer(session.organizationId, id, {
      userId: session.userId,
      ipAddress,
    });

    if (!deleted) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
    }

    return successResponse({ ok: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to delete customer");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
