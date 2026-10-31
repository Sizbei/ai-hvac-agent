import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { listJobTypes, createJobType } from "@/lib/admin/job-type-queries";
import { jobTypeInputSchema } from "@/lib/admin/job-type-types";
import { logAudit } from "@/lib/admin/audit";
import {
  successResponse,
  errorResponse,
  readJsonBody,
} from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** Upper bound on job types per org. */
const MAX_JOB_TYPES = 100;

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:job-types-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const activeOnly = request.nextUrl.searchParams.get("active") === "1";
    const jobTypes = await listJobTypes(
      session.organizationId,
      activeOnly ? { activeOnly: true } : {},
    );
    return successResponse({ jobTypes });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list job types");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:job-types-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }
    const parsed = jobTypeInputSchema.safeParse(body.data);
    if (!parsed.success) {
      return errorResponse(
        "Invalid job type: " + parsed.error.issues[0]?.message,
        "VALIDATION_ERROR",
        400,
      );
    }

    const existing = await listJobTypes(session.organizationId);
    if (existing.length >= MAX_JOB_TYPES) {
      return errorResponse(
        `You can have at most ${MAX_JOB_TYPES} job types.`,
        "LIMIT_REACHED",
        409,
      );
    }

    const result = await createJobType(session.organizationId, parsed.data);
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
      action: "create_job_type",
      entity: "job_types",
      entityId: result.id,
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit job type creation");
    });

    return successResponse({ jobType: result }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create job type");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
