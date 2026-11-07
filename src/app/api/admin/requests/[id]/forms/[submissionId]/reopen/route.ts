/**
 * POST /api/admin/requests/[id]/forms/[submissionId]/reopen `{ revision }` —
 * the office reopens a submitted form (M3d spec §5.5). Already a draft → 200
 * `{ changed: false }`; erased → 409 ANSWERS_REMOVED; moved on → 409 STALE.
 * Audit `form_reopened` only when it changed. Nobody is notified.
 */
import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { errorResponse, readJsonBody, successResponse } from "@/lib/api-response";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";
import { logAudit } from "@/lib/admin/audit";
import { reopenSubmission } from "@/lib/admin/form-queries";
import { FORM_OFFICE_COPY, reopenBodySchema } from "@/lib/admin/form-route-copy";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; submissionId: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:forms-reopen:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const { id, submissionId } = await params;
    if (!isUuid(id) || !isUuid(submissionId)) return errorResponse("Invalid ID format", "INVALID_ID", 400);
    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const parsed = reopenBodySchema.safeParse(body.data);
    if (!parsed.success) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);

    const r = await reopenSubmission(session.organizationId, id, submissionId, parsed.data.revision);
    if (!r.ok) {
      if (r.reason === "not_found") return errorResponse("Form not found", "NOT_FOUND", 404);
      if (r.reason === "answers_removed") return errorResponse(FORM_OFFICE_COPY.ANSWERS_REMOVED, "ANSWERS_REMOVED", 409);
      return errorResponse(FORM_OFFICE_COPY.REOPEN_STALE, "STALE", 409);
    }
    if (r.changed) {
      await logAudit({
        organizationId: session.organizationId, userId: session.userId, action: "form_reopened", entity: "form_submissions",
        entityId: submissionId, details: JSON.stringify({ formId: r.formId, appointmentId: r.appointmentId }),
      }).catch((e: unknown) => logger.error({ code: errorCode(e) }, "Failed to audit form reopen"));
    }
    return successResponse({ revision: r.revision, changed: r.changed });
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to reopen form");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
