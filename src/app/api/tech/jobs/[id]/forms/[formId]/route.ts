/**
 * GET /api/tech/jobs/[id]/forms/[formId]?visit=<aid> — one form for the fill
 * page (M3d spec §6): the row's snapshot when it exists, else the live form;
 * an archived form with no row → 409 FORM_ARCHIVED; a foreign form id → 404
 * "This form is no longer on this job."; an unreadable job → 404 "This job isn't yours."
 */
import type { NextRequest } from "next/server";
import { getTechSession } from "@/lib/auth/tech-session";
import { rateKeyFor } from "@/lib/tech/tech-preview";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse, successResponse } from "@/lib/api-response";
import { errorCode, logger } from "@/lib/logger";
import { getJobForm } from "@/lib/tech/form-reads";
import { FORM_REASON } from "@/lib/tech/form-errors";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; formId: string }> }) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const { id, formId } = await params;
    const visit = request.nextUrl.searchParams.get("visit");
    if (!isUuid(id) || !isUuid(formId) || !isUuid(visit)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const rate = slidingWindow(`tech:form:read:${rateKeyFor(session)}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
    const r = await getJobForm(session.organizationId, session.userId, id, formId, visit);
    if (r.kind === "job_not_found") return errorResponse(FORM_REASON.job_not_found.message, "NOT_FOUND", 404);
    if (r.kind === "not_found") return errorResponse(FORM_REASON.not_found.message, "NOT_FOUND", 404);
    if (r.kind === "archived") return errorResponse(FORM_REASON.form_archived.message, "FORM_ARCHIVED", 409);
    return successResponse(r.view);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load job form");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}
