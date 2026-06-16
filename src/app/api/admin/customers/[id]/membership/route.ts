import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { getCustomerById } from "@/lib/admin/crm-queries";
import {
  enrollCustomer,
  cancelMembership,
  getActiveMembership,
} from "@/lib/admin/membership-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const enrollSchema = z.object({
  planId: z.string().uuid(),
  chargeFirstPeriod: z.boolean().optional(),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:membership-get:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    const customer = await getCustomerById(session.organizationId, id);
    if (!customer) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
    }

    const membership = await getActiveMembership(session.organizationId, id);
    return successResponse({ membership });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch customer membership");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:membership-enroll:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    const customer = await getCustomerById(session.organizationId, id);
    if (!customer) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
    }

    const parsed = enrollSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid enrollment", "VALIDATION_ERROR", 400);
    }

    const result = await enrollCustomer(
      session.organizationId,
      id,
      parsed.data.planId,
      { chargeFirstPeriod: parsed.data.chargeFirstPeriod },
    );

    if (!result.ok) {
      if (result.reason === "plan_not_found") {
        return errorResponse("Plan not found", "NOT_FOUND", 404);
      }
      if (result.reason === "already_enrolled") {
        return errorResponse(
          "Customer already has an active membership",
          "ALREADY_ENROLLED",
          409,
        );
      }
      return errorResponse("Membership charge failed", "CHARGE_FAILED", 402);
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "enroll_membership",
      entity: "customer_membership",
      entityId: result.membershipId,
      details: `customerId=${id};planId=${parsed.data.planId}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, membershipId: result.membershipId },
        "Failed to write audit log for membership enrollment",
      );
    });

    return successResponse({ membershipId: result.membershipId }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to enroll customer in membership");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:membership-cancel:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    const customer = await getCustomerById(session.organizationId, id);
    if (!customer) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
    }

    const result = await cancelMembership(session.organizationId, id);
    if (!result.ok) {
      return errorResponse(
        "Customer has no active membership",
        "NOT_A_MEMBER",
        404,
      );
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "cancel_membership",
      entity: "customer_membership",
      entityId: id,
      details: `customerId=${id}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, customerId: id },
        "Failed to write audit log for membership cancellation",
      );
    });

    return successResponse({ cancelled: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to cancel customer membership");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
