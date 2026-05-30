import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import {
  getConversationById,
  deleteConversation,
} from "@/lib/admin/conversation-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
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
      return errorResponse("Invalid conversation ID format", "INVALID_ID", 400);
    }

    const detail = await getConversationById(session.organizationId, id);
    if (!detail) {
      return errorResponse("Conversation not found", "NOT_FOUND", 404);
    }

    return successResponse(detail);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch conversation detail");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
      return errorResponse("Invalid conversation ID format", "INVALID_ID", 400);
    }

    const deleted = await deleteConversation(session.organizationId, id, {
      userId: session.userId,
      ipAddress,
    });
    if (!deleted) {
      return errorResponse("Conversation not found", "NOT_FOUND", 404);
    }

    return successResponse({ ok: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to delete conversation");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
