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
  archiveCustomer,
} from "@/lib/admin/crm-queries";
import { isUuid } from "@/lib/validation/uuid";
import {
  updateEquipment,
  deleteEquipment,
  isEquipmentType,
} from "@/lib/admin/crm-equipment-queries";
import { logAudit } from "@/lib/admin/audit";
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
    if (!isUuid(id)) {
      return errorResponse("Not found", "NOT_FOUND", 404);
    }
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

    // Verify the customer belongs to THIS org before ANY mutation — without it, an
    // admin could POST to another tenant's customer id and create org-attributed
    // child rows (equipment/notes/follow-ups) referencing a customer they don't
    // own. GET already gates this way; make POST consistent.
    const owned = await getCustomerById(session.organizationId, id);
    if (!owned) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
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
        if (!isEquipmentType(equipmentType)) {
          return errorResponse(
            "Invalid equipment type",
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
          warrantyType:
            typeof body.warrantyType === "string"
              ? body.warrantyType
              : undefined,
          warrantyProvider:
            typeof body.warrantyProvider === "string"
              ? body.warrantyProvider
              : undefined,
          locationInHome:
            typeof body.locationInHome === "string"
              ? body.locationInHome
              : undefined,
          notes: typeof body.notes === "string" ? body.notes : undefined,
        });
        return successResponse({ ok: true }, 201);
      }

      case "update_equipment": {
        const equipmentId =
          typeof body.equipmentId === "string" ? body.equipmentId : "";
        if (!UUID_REGEX.test(equipmentId)) {
          return errorResponse(
            "Valid equipment ID is required",
            "VALIDATION_ERROR",
            400,
          );
        }

        // Present-key patch: a key on the body is written; for nullable text
        // columns an empty string clears the field (→ null). equipmentType, if
        // present, must be a non-empty string (the query validates the enum).
        const patch: {
          equipmentType?: string;
          make?: string | null;
          model?: string | null;
          serialNumber?: string | null;
          installDate?: string | null;
          warrantyExpiration?: string | null;
          warrantyType?: string | null;
          warrantyProvider?: string | null;
          locationInHome?: string | null;
          notes?: string | null;
        } = {};

        const strOrNull = (v: unknown): string | null =>
          typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

        if (typeof body.equipmentType === "string" && body.equipmentType) {
          patch.equipmentType = body.equipmentType;
        }
        if ("make" in body) patch.make = strOrNull(body.make);
        if ("model" in body) patch.model = strOrNull(body.model);
        if ("serialNumber" in body) {
          patch.serialNumber = strOrNull(body.serialNumber);
        }
        if ("installDate" in body) {
          patch.installDate = strOrNull(body.installDate);
        }
        if ("warrantyExpiration" in body) {
          patch.warrantyExpiration = strOrNull(body.warrantyExpiration);
        }
        if ("warrantyType" in body) {
          patch.warrantyType = strOrNull(body.warrantyType);
        }
        if ("warrantyProvider" in body) {
          patch.warrantyProvider = strOrNull(body.warrantyProvider);
        }
        if ("locationInHome" in body) {
          patch.locationInHome = strOrNull(body.locationInHome);
        }
        if ("notes" in body) patch.notes = strOrNull(body.notes);

        const result = await updateEquipment(
          session.organizationId,
          id,
          equipmentId,
          patch,
        );
        if (!result.ok) {
          switch (result.reason) {
            case "invalid_type":
              return errorResponse(
                "Invalid equipment type",
                "VALIDATION_ERROR",
                400,
              );
            case "no_changes":
              return errorResponse(
                "No valid changes provided",
                "VALIDATION_ERROR",
                400,
              );
            case "not_found":
              return errorResponse("Equipment not found", "NOT_FOUND", 404);
          }
        }

        await logAudit({
          organizationId: session.organizationId,
          userId: session.userId,
          action: "update_equipment",
          entity: "customer_equipment",
          entityId: equipmentId,
          // Field NAMES actually written (from the query, not the request) —
          // make/model/serial are never logged as values.
          details: JSON.stringify({ fields: result.updatedFields }),
          ipAddress,
        });
        return successResponse({ ok: true });
      }

      case "delete_equipment": {
        const equipmentId =
          typeof body.equipmentId === "string" ? body.equipmentId : "";
        if (!UUID_REGEX.test(equipmentId)) {
          return errorResponse(
            "Valid equipment ID is required",
            "VALIDATION_ERROR",
            400,
          );
        }

        const deleted = await deleteEquipment(
          session.organizationId,
          id,
          equipmentId,
        );
        if (!deleted) {
          return errorResponse("Equipment not found", "NOT_FOUND", 404);
        }

        await logAudit({
          organizationId: session.organizationId,
          userId: session.userId,
          action: "delete_equipment",
          entity: "customer_equipment",
          entityId: equipmentId,
          ipAddress,
        });
        return successResponse({ ok: true });
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

      case "archive": {
        const archived = await archiveCustomer(session.organizationId, id, {
          userId: session.userId,
          ipAddress,
        });
        if (!archived) {
          return errorResponse("Customer not found", "NOT_FOUND", 404);
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
