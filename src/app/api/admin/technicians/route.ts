import { getAdminSession } from "@/lib/auth/session";
import { getTechnicians, createTechnician } from "@/lib/admin/queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { z } from "zod";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const technicians = await getTechnicians(session.organizationId);
    return successResponse({ technicians });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch technicians");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

const createTechnicianSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

export async function POST(request: Request) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const body: unknown = await request.json();
    const parsed = createTechnicianSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body: name required, valid email required, password min 8 chars",
        "VALIDATION_ERROR",
        400,
      );
    }

    const technician = await createTechnician(
      session.organizationId,
      parsed.data,
    );

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_technician",
      entity: "user",
      entityId: technician.id,
    });

    return successResponse(technician, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create technician");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
