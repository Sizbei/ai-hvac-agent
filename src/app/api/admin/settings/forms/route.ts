/**
 * GET /api/admin/settings/forms — the Forms tab list.
 * POST — first valid Save of a new form (M3d spec §4.1): id =
 * officeId("form", org, clientToken); 201 created, 200 replay; audit
 * `form_created` only when created.
 */
import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { errorResponse, readJsonBody, successResponse } from "@/lib/api-response";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";
import { logAudit } from "@/lib/admin/audit";
import { createForm, listForms } from "@/lib/admin/form-queries";
import { createFormBodySchema, FORM_OFFICE_COPY } from "@/lib/admin/form-route-copy";
import { firstIssuePath } from "@/lib/forms/form-schema";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:forms-list:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    return successResponse({ forms: await listForms(session.organizationId) });
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to list forms");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:forms-create:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const parsed = createFormBodySchema.safeParse(body.data);
    if (!parsed.success) return errorResponse("Invalid form", "VALIDATION_ERROR", 400, { path: firstIssuePath(parsed.error) });
    const { clientToken, ...def } = parsed.data;

    const r = await createForm(session.organizationId, session.userId, clientToken, def);
    if (!r.ok) {
      if (r.reason === "name_taken") return errorResponse(FORM_OFFICE_COPY.NAME_TAKEN, "NAME_TAKEN", 409);
      if (r.reason === "limit_reached") return errorResponse(FORM_OFFICE_COPY.LIMIT_REACHED, "LIMIT_REACHED", 409);
      return errorResponse(FORM_OFFICE_COPY.UNKNOWN_JOB_TYPE, "UNKNOWN_JOB_TYPE", 400);
    }
    if (r.created) {
      await logAudit({
        organizationId: session.organizationId, userId: session.userId, action: "form_created", entity: "forms", entityId: r.id,
        details: JSON.stringify({ formId: r.id }),
      }).catch((e: unknown) => logger.error({ code: errorCode(e) }, "Failed to audit form creation"));
    }
    return successResponse({ id: r.id }, r.created ? 201 : 200);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to create form");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
