import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { suggestTechnicians } from "@/lib/admin/scheduling-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/admin/dispatch/suggest/[id]
 * Read-only top-3 scored technician suggestions (with reasons) for a request —
 * the advisory exceptions-queue feed. Org is taken from the SESSION, never the
 * request. Never mutates: a dispatcher still commits the assignment.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const suggestions = await suggestTechnicians(session.organizationId, id, 3);
    return successResponse({ suggestions });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to load technician suggestions");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
