import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getRequests } from "@/lib/admin/queries";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";
import { businessIsoDate } from "@/lib/admin/calendar-time";
import type { RequestSortKey } from "@/lib/admin/types";
import { hasTimeOff } from "@/lib/admin/shift-types";

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:requests-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const url = request.nextUrl;
    const status = url.searchParams.get("status") ?? undefined;
    const searchParam = url.searchParams.get("search") ?? undefined;
    const pageParam = url.searchParams.get("page");
    const limitParam = url.searchParams.get("limit");
    const urgency = url.searchParams.get("urgency") ?? undefined;
    const assignedTo = url.searchParams.get("assignedTo") ?? undefined;
    const isAfterHoursParam = url.searchParams.get("isAfterHours");
    const sortParam = url.searchParams.get("sort") ?? undefined;

    const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;
    const limit = limitParam
      ? Math.min(100, Math.max(1, parseInt(limitParam, 10) || 50))
      : 50;

    // Cap the search term defensively; it can't usefully exceed a 20-char
    // reference number anyway.
    const search = searchParam ? searchParam.slice(0, 64) : undefined;
    const isAfterHours = isAfterHoursParam === "true" ? true : undefined;
    const VALID_SORTS: readonly string[] = ['newest', 'oldest', 'urgency'];
    const sort = (sortParam !== undefined && VALID_SORTS.includes(sortParam)
      ? sortParam
      : undefined) as RequestSortKey | undefined;

    const result = await getRequests(session.organizationId, {
      status,
      search,
      page,
      limit,
      urgency,
      assignedTo,
      isAfterHours,
      sort,
    });

    return successResponse({
      requests: result.requests,
      total: result.total,
      page,
      limit,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch admin requests");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

/**
 * POST /api/admin/requests — the office books a request (job).
 *
 * Body: `customerId` OR inline `customer: { name, phone?, email? }` (deduped by
 * phone/email), `address`, `issueType`, `urgency`, `description`, optional
 * `jobType` (derived from the issue when omitted), `accessNotes`, `systemType`,
 * `preferredWindow`, `schedule: { isoDay, window, technicianId? }`, `override`.
 *
 * With a technician, the conflict gate runs before anything is written: a clash
 * returns 409 SCHEDULE_CONFLICT with the conflict detail and NO request is
 * created; resubmitting with `override: true` books it anyway. Returns 201
 * `{ request, requestId, referenceNumber, schedule }`; `request` is a
 * getRequests-shaped row or null if the read-back failed. Once the request is
 * saved the response is always 201 — a scheduling failure after the save comes
 * back as `schedule.kind === "failed"`, never a 500.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:requests-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      return errorResponse("Invalid JSON body", "VALIDATION_ERROR", 400);
    }
    // Loaded on demand so the hot GET list path doesn't pull the booking write
    // graph (scheduling, integrations, intake schema) in at module load.
    const [{ parseCreateRequestBody, scheduleConflictMessage }, { createAdminRequest }] =
      await Promise.all([
        import("@/lib/admin/create-request"),
        import("@/lib/admin/create-request-queries"),
      ]);
    const parsed = parseCreateRequestBody(bodyResult.data, businessIsoDate(new Date()));
    if (!parsed.ok) {
      return errorResponse(parsed.message, "VALIDATION_ERROR", 400);
    }

    const result = await createAdminRequest({
      organizationId: session.organizationId,
      userId: session.userId,
      input: parsed.data,
      ipAddress: clientIp(request),
    });

    if (!result.ok) {
      switch (result.reason) {
        case "customer_not_found":
          return errorResponse("Customer not found", "CUSTOMER_NOT_FOUND", 404);
        case "do_not_service":
          return errorResponse(
            "This customer is marked do not service.",
            "DO_NOT_SERVICE",
            422,
          );
        case "technician_not_found":
          return errorResponse(
            "Technician not found, not active, or not a technician",
            "TECHNICIAN_NOT_FOUND",
            404,
          );
        case "job_type_not_found":
          return errorResponse("That job type isn't available.", "JOB_TYPE_NOT_FOUND", 400);
        case "contact_not_owned":
          return errorResponse(
            "That contact doesn't belong to this customer.",
            "CONTACT_NOT_OWNED",
            400,
          );
        case "location_not_owned":
          return errorResponse(
            "That location doesn't belong to this customer.",
            "LOCATION_NOT_OWNED",
            400,
          );
        case "unknown_tag":
          return errorResponse("One of those tags doesn't exist.", "UNKNOWN_TAG", 400);
        case "conflict":
          if (hasTimeOff(result.detail.conflicts)) {
            return errorResponse(
              "That technician is off during this window.",
              "TIME_OFF",
              409,
              result.detail,
            );
          }
          return errorResponse(
            scheduleConflictMessage({
              conflictCount: result.detail.conflicts.length,
              outsideAvailability: result.detail.outsideAvailability,
            }),
            "SCHEDULE_CONFLICT",
            409,
            result.detail,
          );
      }
    }

    // Shape the response like a list row so a caller can show it directly.
    // Best-effort: the request is already saved, so a failed read-back must
    // not turn into an error the office would answer by booking it again.
    const listRow = await getRequests(session.organizationId, {
      search: result.referenceNumber,
      limit: 1,
    })
      .then(({ requests }) => requests[0] ?? null)
      .catch((readError: unknown) => {
        logger.error(
          { error: readError, requestId: result.requestId },
          "Office request saved but the list-row read-back failed",
        );
        return null;
      });

    return successResponse(
      {
        request: listRow,
        requestId: result.requestId,
        referenceNumber: result.referenceNumber,
        schedule: result.schedule,
      },
      201,
    );
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create admin request");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
