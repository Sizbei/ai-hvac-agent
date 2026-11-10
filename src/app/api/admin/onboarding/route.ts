import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { getGoogleOidcConfig } from "@/lib/auth/google-oidc";
import { getOnboarding, patchOnboarding } from "@/lib/admin/onboarding-queries";
import { logAudit } from "@/lib/admin/audit";
import { isDemoOrg } from "@/lib/tenancy/demo-mode";
import {
  successResponse,
  errorResponse,
  readJsonBody,
} from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** GET — the setup guide payload for the session's org. */
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

    const payload = await getOnboarding(session.organizationId, {
      demo: isDemoOrg(session.organizationId),
      googleEnabled: getGoogleOidcConfig() !== null,
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
    });
    return successResponse(payload);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to load onboarding state");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

const patchSchema = z
  .strictObject({
    dismissed: z.literal(true).optional(),
    showOnHome: z.literal(true).optional(),
    completedSeen: z.literal(true).optional(),
    flags: z
      .strictObject({ embedCopied: z.literal(true).optional() })
      .optional(),
  })
  .refine(
    (v) =>
      v.dismissed === true ||
      v.showOnHome === true ||
      v.completedSeen === true ||
      v.flags?.embedCopied === true,
    { message: "At least one field must be true" },
  )
  // showOnHome undoes a dismissal: alone, never mixed with other writes.
  .refine(
    (v) =>
      v.showOnHome !== true ||
      (v.dismissed === undefined && v.completedSeen === undefined && v.flags === undefined),
    { message: "showOnHome must be sent alone" },
  );

/** PATCH — persist the non-derivable setup guide signals. */
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

    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }
    const parsed = patchSchema.safeParse(parsedBody.data);
    if (!parsed.success) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }

    const body = parsed.data;
    const orgId = session.organizationId;
    const demo = isDemoOrg(orgId);
    const state = await patchOnboarding(orgId, body, { demo });

    if (!demo) {
      const keys = [
        ...(body.dismissed ? ["dismissed"] : []),
        ...(body.showOnHome ? ["showOnHome"] : []),
        ...(body.completedSeen ? ["completedSeen"] : []),
        ...(body.flags?.embedCopied ? ["flags.embedCopied"] : []),
      ];
      // The write has committed: an audit failure is logged, never a 500.
      try {
        await logAudit({
          organizationId: orgId,
          userId: session.userId,
          action: "onboarding_updated",
          entity: "organization_settings",
          entityId: orgId,
          details: JSON.stringify({ keys }),
        });
      } catch (auditError: unknown) {
        logger.error(
          { error: auditError, organizationId: orgId },
          "Onboarding audit write failed after a committed update",
        );
      }
    }

    return successResponse(state);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to update onboarding state");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
