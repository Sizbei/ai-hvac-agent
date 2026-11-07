/**
 * GET /api/admin/settings/forms/[id] — `{ form, submissionCount }`, org-scoped
 * (a foreign id is 404). PATCH — `{ version, definition }` (fields replaced
 * whole) or `{ version, active }` (archive / restore) under a version CAS
 * (M3d spec §4.1, §5.6). Audits `form_updated` / `form_archived` /
 * `form_restored`, ids and enums only.
 */
import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { errorResponse, readJsonBody, successResponse } from "@/lib/api-response";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";
import { logAudit } from "@/lib/admin/audit";
import { getForm, updateForm } from "@/lib/admin/form-queries";
import { FORM_OFFICE_COPY, patchFormBodySchema } from "@/lib/admin/form-route-copy";
import { firstIssuePath } from "@/lib/forms/form-schema";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:forms-read:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid form ID format", "INVALID_ID", 400);
    const r = await getForm(session.organizationId, id);
    if (!r) return errorResponse(FORM_OFFICE_COPY.NOT_FOUND, "NOT_FOUND", 404);
    return successResponse(r);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load form");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:forms-update:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid form ID format", "INVALID_ID", 400);
    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const parsed = patchFormBodySchema.safeParse(body.data);
    if (!parsed.success) return errorResponse("Invalid form", "VALIDATION_ERROR", 400, { path: firstIssuePath(parsed.error) });

    const r = await updateForm(session.organizationId, id, parsed.data);
    if (!r.ok) {
      if (r.reason === "not_found") return errorResponse(FORM_OFFICE_COPY.NOT_FOUND, "NOT_FOUND", 404);
      if (r.reason === "stale") return errorResponse(FORM_OFFICE_COPY.STALE, "STALE", 409);
      if (r.reason === "name_taken") return errorResponse(FORM_OFFICE_COPY.NAME_TAKEN, "NAME_TAKEN", 409);
      return errorResponse(FORM_OFFICE_COPY.UNKNOWN_JOB_TYPE, "UNKNOWN_JOB_TYPE", 400);
    }
    const d = parsed.data;
    const audits: { action: string; details: Record<string, unknown> }[] = [];
    if (d.definition) audits.push({ action: "form_updated", details: { formId: id, version: r.version, fieldCount: d.definition.fields.length } });
    if (d.active === false) audits.push({ action: "form_archived", details: { formId: id, version: r.version } });
    if (d.active === true) audits.push({ action: "form_restored", details: { formId: id, version: r.version } });
    for (const a of audits) {
      await logAudit({
        organizationId: session.organizationId, userId: session.userId, action: a.action, entity: "forms", entityId: id,
        details: JSON.stringify(a.details),
      }).catch((e: unknown) => logger.error({ code: errorCode(e) }, "Failed to audit form update"));
    }
    return successResponse({ version: r.version });
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to update form");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
