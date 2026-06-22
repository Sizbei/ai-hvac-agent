/**
 * FIELDPULSE BULK JOB STATUS UPDATE
 *
 *   POST — bulk update job statuses with rate limiting and partial success.
 *
 * Admin-session-gated. Handles bulk status updates for multiple jobs in a single
 * request with:
 * - Token bucket rate limiting per organization
 * - Partial success mode (continues on individual failures)
 * - Comprehensive error aggregation
 * - Detailed operation summary
 */
import { getAdminSession } from "@/lib/auth/session";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { getFieldpulseClient } from "@/lib/integrations/fieldpulse/client";
import {
  bulkUpdateJobStatus,
  validateBulkUpdates,
  getRateLimitInfo,
} from "@/lib/integrations/fieldpulse/bulk-operations";
import type {
  BulkJobStatusUpdateRequest,
  BulkJobStatusUpdateResponse,
  BulkOperationError,
} from "@/lib/integrations/fieldpulse/bulk-types";

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:fieldpulse-bulk:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const rawBody: unknown = await req.json();
    // Guard the shape before trusting it — a null/array/missing-updates body
    // must produce a clean 400, never a destructure TypeError -> 500.
    if (
      typeof rawBody !== "object" ||
      rawBody === null ||
      !Array.isArray((rawBody as { updates?: unknown }).updates)
    ) {
      return errorResponse(
        "Invalid request: 'updates' must be an array",
        "INVALID_INPUT",
        400,
      );
    }
    const { updates, options = {} } = rawBody as BulkJobStatusUpdateRequest;

    // Validate input
    const validationErrors = validateBulkUpdates(updates);
    if (validationErrors.length > 0) {
      return errorResponse(
        `Invalid request: ${validationErrors.join(", ")}`,
        "INVALID_INPUT",
        400
      );
    }

    // Get Fieldpulse client
    const client = await getFieldpulseClient(session.organizationId);
    if (!client) {
      return errorResponse(
        "Fieldpulse not configured for this organization",
        "NOT_CONFIGURED",
        400
      );
    }

    // Execute bulk update with organization-scoped rate limiting
    const clientId = `org:${session.organizationId}`;
    const summary = await bulkUpdateJobStatus(client, updates, options, clientId);

    // Get aggregated errors for monitoring
    const aggregatedErrors = Array.from(
      summary.results
        .filter((r) => !r.success)
        .reduce((map, result) => {
          const errorType: BulkOperationError["type"] = result.statusCode === 429
            ? "rate_limit"
            : result.statusCode === 408
              ? "network"
              : result.statusCode && result.statusCode >= 500
                ? "api_error"
                : "validation";

          const existing = map.get(errorType);
          if (existing) {
            existing.count++;
            existing.sampleJobIds = [
              ...existing.sampleJobIds,
              result.fieldpulseJobId,
            ].slice(-10);
          } else {
            map.set(errorType, {
              type: errorType,
              count: 1,
              message: result.error ?? "unknown",
              sampleJobIds: [result.fieldpulseJobId],
            });
          }
          return map;
        },
        new Map<BulkOperationError["type"], {
          type: BulkOperationError["type"];
          count: number;
          message: string;
          sampleJobIds: string[];
        }>())
        .values()
    );

    const response: BulkJobStatusUpdateResponse = {
      summary,
      aggregatedErrors,
      completeSuccess: summary.failed === 0,
    };

    logger.info(
      {
        organizationId: session.organizationId,
        userId: session.userId,
        total: summary.total,
        succeeded: summary.succeeded,
        failed: summary.failed,
        durationMs: summary.durationMs,
      },
      "Bulk job status update completed"
    );

    return successResponse(response);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to process bulk job status update");

    // Handle JSON parse errors
    if (error instanceof SyntaxError && error.message.includes("JSON")) {
      return errorResponse("Invalid JSON in request body", "INVALID_JSON", 400);
    }

    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

/**
 * GET — current rate limit info for the organization.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:fieldpulse-bulk-status:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const clientId = `org:${session.organizationId}`;
    const rateInfo = getRateLimitInfo(clientId);

    return successResponse({
      rateLimit: {
        state: rateInfo.state,
        remaining: rateInfo.remaining,
        resetMs: rateInfo.resetMs,
        suggestedDelayMs: rateInfo.suggestedDelayMs,
      },
      organizationId: session.organizationId,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to get rate limit info");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
