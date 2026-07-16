import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  listMembershipPlans,
  createMembershipPlan,
} from "@/lib/admin/membership-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** Business cap: $999,999.99 = 99,999,999 cents. */
const MAX_PRICE_CENTS = 99_999_999;

const planSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullable().optional(),
  priceCents: z.number().int().min(0).max(MAX_PRICE_CENTS),
  billingPeriod: z.enum(["monthly", "annual"]),
  visitsPerYear: z.number().int().min(0).max(12).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:membership-plans-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const includeInactive =
      request.nextUrl.searchParams.get("includeInactive") === "true";
    const plans = await listMembershipPlans(session.organizationId, {
      includeInactive,
    });
    return successResponse({ plans });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch membership plans");
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
      `admin:membership-plans-create:${session.userId}`,
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
    const parsed = planSchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return errorResponse("Invalid membership plan", "VALIDATION_ERROR", 400);
    }

    const id = await createMembershipPlan(session.organizationId, parsed.data);

    // H1: strip money values from audit details — log name/billingPeriod only.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_membership_plan",
      entity: "membership_plan",
      entityId: id,
      details: `billingPeriod=${parsed.data.billingPeriod};name=${parsed.data.name}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, planId: id },
        "Failed to write audit log for membership plan creation",
      );
    });

    return successResponse({ id }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create membership plan");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
