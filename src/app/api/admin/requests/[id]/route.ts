import { getAdminSession } from "@/lib/auth/session";
import { getRequestById } from "@/lib/admin/queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;

    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const detail = await getRequestById(session.organizationId, id);
    if (!detail) {
      return errorResponse("Request not found", "NOT_FOUND", 404);
    }

    return successResponse(detail);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch request detail");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
