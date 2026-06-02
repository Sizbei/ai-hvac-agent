import { getAdminSession } from "@/lib/auth/session";
import { updateTechnician } from "@/lib/admin/queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { z } from "zod";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const updateTechnicianSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;

    if (!UUID_REGEX.test(id)) {
      return errorResponse(
        "Invalid technician ID format",
        "INVALID_ID",
        400,
      );
    }

    const body: unknown = await request.json();
    const parsed = updateTechnicianSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body: name, email, or isActive expected",
        "VALIDATION_ERROR",
        400,
      );
    }

    const technician = await updateTechnician(
      session.organizationId,
      id,
      parsed.data,
    );
    if (!technician) {
      return errorResponse("Technician not found", "NOT_FOUND", 404);
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update_technician",
      entity: "user",
      entityId: id,
      // Log only WHICH fields changed — never the values. name/email are PII
      // and the audit-log viewer surfaces `details` verbatim.
      details: JSON.stringify({ fields: Object.keys(parsed.data) }),
    });

    return successResponse(technician);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update technician");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
