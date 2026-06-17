import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  getOnboardingState,
  updateOnboardingFlags,
} from "@/lib/admin/onboarding-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** GET — the current onboarding checklist state for the session's org. */
export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:onboarding-get:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const state = await getOnboardingState(session.organizationId);
    return successResponse({ onboarding: state });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to load onboarding state");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

const patchSchema = z
  .object({
    dismissed: z.boolean().optional(),
    embedViewed: z.boolean().optional(),
  })
  .refine((v) => v.dismissed !== undefined || v.embedViewed !== undefined, {
    message: "At least one of dismissed or embedViewed is required",
  });

/** PATCH — persist the non-derivable onboarding flags (dismissed/embedViewed). */
export async function PATCH(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:onboarding-patch:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid request body: dismissed and/or embedViewed (boolean) required",
        "VALIDATION_ERROR",
        400,
      );
    }

    await updateOnboardingFlags(session.organizationId, parsed.data);
    const state = await getOnboardingState(session.organizationId);
    return successResponse({ onboarding: state });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update onboarding state");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
