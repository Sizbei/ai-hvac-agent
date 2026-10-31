import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { updateJobType } from "@/lib/admin/job-type-queries";
import { jobTypePatchSchema } from "@/lib/admin/job-type-types";
import { logAudit } from "@/lib/admin/audit";
import {
  successResponse,
  errorResponse,
  readJsonBody,
} from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      `admin:job-types-update:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid job type ID format", "INVALID_ID", 400);
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }
    const parsed = jobTypePatchSchema.safeParse(body.data);
    if (!parsed.success) {
      return errorResponse(
        "Invalid job type: " + parsed.error.issues[0]?.message,
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await updateJobType(session.organizationId, id, parsed.data);
    if (result === null) {
      return errorResponse("Job type not found", "NOT_FOUND", 404);
    }
    if ("conflict" in result) {
      return errorResponse(
        "A job type with that name already exists.",
        "DUPLICATE_NAME",
        409,
      );
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update_job_type",
      entity: "job_types",
      entityId: id,
      details: JSON.stringify({ fields: Object.keys(parsed.data) }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit job type update");
    });

    return successResponse({ jobType: result });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update job type");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
