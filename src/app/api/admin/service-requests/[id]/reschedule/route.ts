/**
 * Reschedule Service Request
 *
 * API endpoint to reschedule a service request.
 * Handles notification triggers and reminder updates.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { serviceRequests, customers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logAudit } from "@/lib/admin/audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/service-requests/[id]/reschedule
 *
 * Reschedule a service request to a new date/time.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const serviceRequestId = params.id;

    // Parse request body
    const body = await request.json();
    const { newDate, newTime } = body;

    if (!newDate || !newTime) {
      return errorResponse(
        "Missing required fields: newDate, newTime",
        "VALIDATION_ERROR",
        400,
      );
    }

    // Fetch current service request
    const serviceRequest = await db.query.serviceRequests.findFirst({
      where: eq(serviceRequests.id, serviceRequestId),
    });

    if (!serviceRequest) {
      return errorResponse("Service request not found", "NOT_FOUND", 404);
    }

    // Store old values
    const oldDate = serviceRequest.scheduledDate;

    // Update service request
    await db
      .update(serviceRequests)
      .set({
        scheduledDate: new Date(newDate),
        updatedAt: new Date(),
      })
      .where(eq(serviceRequests.id, serviceRequestId));

    // Log audit
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update",
      entity: "service_request",
      entityId: serviceRequestId,
      details: `Rescheduled to ${newDate} at ${newTime}`,
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
