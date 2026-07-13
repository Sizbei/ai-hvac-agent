/**
 * Reschedule Service Request
 *
 * API endpoint to reschedule a service request.
 * Handles notification triggers and reminder updates.
 */

import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db/tenant";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logAudit } from "@/lib/admin/audit";
import { logger } from "@/lib/logger";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation/uuid";

export const dynamic = "force-dynamic";

/** HH:MM 24-hour time. */
const TIME_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * POST /api/admin/service-requests/[id]/reschedule
 *
 * Reschedule a service request to a new date/time.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:reschedule:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id: serviceRequestId } = await params;
    if (!isUuid(serviceRequestId)) {
      return errorResponse("Invalid ID", "VALIDATION_ERROR", 400);
    }

    // Parse + validate request body
    const body = await request.json();
    const { newDate, newTime } = body ?? {};

    if (typeof newDate !== "string" || typeof newTime !== "string") {
      return errorResponse(
        "Missing required fields: newDate, newTime",
        "VALIDATION_ERROR",
        400,
      );
    }
    const parsedDate = new Date(newDate);
    if (Number.isNaN(parsedDate.getTime()) || !TIME_PATTERN.test(newTime)) {
      return errorResponse(
        "Invalid newDate or newTime",
        "VALIDATION_ERROR",
        400,
      );
    }

    // Fetch current service request — SCOPED TO THE CALLER'S ORG so one admin
    // can never read or reschedule another tenant's request by UUID.
    const [serviceRequest] = await db
      .select({ scheduledDate: serviceRequests.scheduledDate })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          session.organizationId,
          eq(serviceRequests.id, serviceRequestId),
        ),
      );

    if (!serviceRequest) {
      return errorResponse("Service request not found", "NOT_FOUND", 404);
    }

    // Store old values
    const oldDate = serviceRequest.scheduledDate;

    // Update service request (org-scoped).
    await db
      .update(serviceRequests)
      .set({
        scheduledDate: parsedDate,
        updatedAt: new Date(),
      })
      .where(
        withTenant(
          serviceRequests,
          session.organizationId,
          eq(serviceRequests.id, serviceRequestId),
        ),
      );

    // Log audit — structured, non-PII fields only.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update",
      entity: "service_request",
      entityId: serviceRequestId,
      details: `scheduledDate:${parsedDate.toISOString()};time:${newTime}`,
    });

    logger.info(
      { serviceRequestId, oldDate, newDate, adminId: session.userId },
      "Service request rescheduled",
    );

    return successResponse({
      serviceRequestId,
      oldDate: oldDate?.toISOString(),
      newDate,
      newTime,
    });
  } catch (error) {
    logger.error({ error }, "Failed to reschedule service request");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
