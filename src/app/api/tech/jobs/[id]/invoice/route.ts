/**
 * GET /api/tech/jobs/[id]/invoice — the field invoice screen (spec §6.2.1).
 * Tech session → UUID → read rate limit → the view: not readable → 404 (never
 * confirming the job exists), FieldPulse/HCP job → 409 MANAGED_EXTERNALLY. Writes live in Task 8's POST handlers.
 */
import type { NextRequest } from "next/server";
import { getTechSession } from "@/lib/auth/tech-session";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { getTechInvoiceView } from "@/lib/tech/invoice-queries";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const rate = slidingWindow(
      `tech:invoice:read:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
    }
    const result = await getTechInvoiceView(session.organizationId, session.userId, id);
    if (result.kind === "not_found") return errorResponse("This job isn't yours.", "NOT_FOUND", 404);
    if (result.kind === "external") {
      return errorResponse("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
    }
    return successResponse(result.view);
  } catch (error) {
    logger.error({ error }, "Failed to load tech invoice view");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}
