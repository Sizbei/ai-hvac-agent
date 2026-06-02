import { getAdminSession } from "@/lib/auth/session";
import { assignTechnician } from "@/lib/admin/queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { z } from "zod";

const assignSchema = z.object({
  technicianId: z.string().uuid(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;

    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const body: unknown = await request.json();
    const parsed = assignSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body: technicianId must be a valid UUID",
        "VALIDATION_ERROR",
        400,
      );
    }

    const { technicianId } = parsed.data;

    const result = await assignTechnician(
      session.organizationId,
      id,
      technicianId,
    );

    if (!result.ok) {
      switch (result.reason) {
        case "technician_not_found":
          return errorResponse(
            "Technician not found, not active, or not a technician",
            "TECHNICIAN_NOT_FOUND",
            404,
          );
        case "request_not_found":
          return errorResponse("Request not found", "NOT_FOUND", 404);
        case "request_not_assignable":
          return errorResponse(
            `Request cannot be assigned while it is '${result.currentStatus}'`,
            "REQUEST_NOT_ASSIGNABLE",
            409,
          );
      }
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "assign_technician",
      entity: "service_request",
      entityId: id,
      details: JSON.stringify({ technicianId }),
    });

    return successResponse(result.request);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to assign technician");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
