/**
 * HOUSECALL PRO BULK JOB OPERATIONS
 *
 *   POST — bulk `cancel` / `note` operations across many jobs, rate-limited with
 *          partial success + error aggregation.
 *   GET  — capability info (HCP supports note/cancel only — no arbitrary status).
 *
 * Admin-session-gated, tenant-scoped (rate-limiter keyed on the org). HCP's
 * `updateJob` has no `work_status`, so unlike the FieldPulse bulk endpoint there
 * is NO arbitrary status update — the supported actions are `note` and `cancel`.
 */
import { getAdminSession } from "@/lib/auth/session";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { getHousecallClient } from "@/lib/integrations/housecall-pro/client";
import {
  bulkJobOperations,
  validateBulkOperations,
  aggregateBulkErrors,
} from "@/lib/integrations/housecall-pro/bulk-operations";
import type {
  BulkOperationRequest,
  BulkOperationResponse,
} from "@/lib/integrations/housecall-pro/bulk-types";

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:housecall-bulk:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const rawBody: unknown = await req.json();
    // Guard the shape before trusting it — a null/array/missing-operations body
    // must produce a clean 400, never a destructure TypeError → 500.
    if (
      typeof rawBody !== "object" ||
      rawBody === null ||
      !Array.isArray((rawBody as { operations?: unknown }).operations)
    ) {
      return errorResponse(
        "Invalid request: 'operations' must be an array",
        "INVALID_INPUT",
        400,
      );
    }
    const { operations, options = {} } = rawBody as BulkOperationRequest;

    const validationErrors = validateBulkOperations(operations);
    if (validationErrors.length > 0) {
      return errorResponse(
        `Invalid request: ${validationErrors.join(", ")}`,
        "INVALID_INPUT",
        400,
      );
    }

    const client = await getHousecallClient(session.organizationId);
    if (!client) {
      return errorResponse(
        "Housecall Pro not configured for this organization",
        "NOT_CONFIGURED",
        400,
      );
    }

    // Org-scoped rate limiting (clientId derives from the SESSION, never the body).
    const clientId = `org:${session.organizationId}`;
    const summary = await bulkJobOperations(client, operations, options, clientId);

    const response: BulkOperationResponse = {
      summary,
      aggregatedErrors: aggregateBulkErrors(summary.results),
      completeSuccess: summary.failed === 0,
    };

    logger.info(
      {
        organizationId: session.organizationId,
        userId: session.userId,
        total: summary.total,
        succeeded: summary.succeeded,
        failed: summary.failed,
      },
      "HCP bulk operation completed",
    );

    return successResponse(response);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to process HCP bulk operation");
    if (error instanceof SyntaxError && error.message.includes("JSON")) {
      return errorResponse("Invalid JSON in request body", "INVALID_JSON", 400);
    }
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function GET(): Promise<Response> {
  const session = await getAdminSession();
  if (!session) {
    return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  }
  // Capability info — documents the HCP-only limitation (no arbitrary status).
  return successResponse({
    supportedActions: ["note", "cancel"],
    supportsStatusBulk: false,
    organizationId: session.organizationId,
  });
}
