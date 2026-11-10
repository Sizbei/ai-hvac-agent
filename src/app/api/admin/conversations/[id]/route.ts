import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getViewerContext } from "@/lib/auth/viewer";
import { isSuperAdmin } from "@/lib/auth/authz";
import { z } from "zod";
import {
  getConversationById,
  deleteConversation,
  setConversationHandled,
} from "@/lib/admin/conversation-queries";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { session } = viewer;

    const { id } = await params;

    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid conversation ID format", "INVALID_ID", 400);
    }

    const detail = await getConversationById(session.organizationId, id, viewer);
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
    // Permanently deleting a conversation is a hard, irreversible destructive
    // action (same tier as customer hard-delete/erase) — restrict to
    // super_admin, matching the other destructive DELETE routes in this repo
    // (customers/[id] hard-delete, customers/[id]/erase).
    if (!isSuperAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const ipAddress = clientIp(request);
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

const patchSchema = z.object({ handled: z.boolean() }).strict();

/**
 * Mark an escalated conversation handled (clears "Needs action") or reopen it.
 * Any admin may do this — it is triage state, not a destructive action.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:conversation-handled:${session.userId}`,
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

    const body = await readJsonBody(request);
    const parsed = body.ok ? patchSchema.safeParse(body.data) : null;
    if (!parsed?.success) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }

    const result = await setConversationHandled(
      session.organizationId,
      id,
      parsed.data.handled,
      { userId: session.userId, ipAddress: clientIp(request) },
    );
    if (!result) {
      return errorResponse("Escalated conversation not found", "NOT_FOUND", 404);
    }

    return successResponse(result);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update conversation handled state");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
