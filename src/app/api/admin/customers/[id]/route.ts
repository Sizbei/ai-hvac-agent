import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import {
  getCustomerById,
  addEquipment,
  addNote,
  addFollowUp,
  deleteCustomer,
} from "@/lib/admin/crm-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

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

      default:
        return errorResponse("Unknown action", "INVALID_ACTION", 400);
    }
  } catch (error: unknown) {
    logger.error({ error }, "Failed to perform customer action");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
