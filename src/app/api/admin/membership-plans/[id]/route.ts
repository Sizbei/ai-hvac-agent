import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  getMembershipPlanById,
  updateMembershipPlan,
  deactivateMembershipPlan,
} from "@/lib/admin/membership-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  priceCents: z.number().int().min(0).optional(),
  billingPeriod: z.enum(["monthly", "annual"]).optional(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:membership-plans-update:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    const existing = await getMembershipPlanById(session.organizationId, id);
    if (!existing) {
      return errorResponse("Plan not found", "NOT_FOUND", 404);
    }

    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid membership plan", "VALIDATION_ERROR", 400);
    }
    if (Object.keys(parsed.data).length === 0) {
      return errorResponse("No fields to update", "VALIDATION_ERROR", 400);
    }

    await updateMembershipPlan(session.organizationId, id, parsed.data);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "update_membership_plan",
      entity: "membership_plan",
      entityId: id,
      details: Object.keys(parsed.data).sort().join(","),
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, planId: id },
        "Failed to write audit log for membership plan update",
      );
    });

    return successResponse({ id });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update membership plan");
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
      `admin:membership-plans-delete:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    const existing = await getMembershipPlanById(session.organizationId, id);
    if (!existing) {
      return errorResponse("Plan not found", "NOT_FOUND", 404);
    }

    await deactivateMembershipPlan(session.organizationId, id);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "deactivate_membership_plan",
      entity: "membership_plan",
      entityId: id,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, planId: id },
        "Failed to write audit log for membership plan deactivation",
      );
    });

    return successResponse({ id });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to deactivate membership plan");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
