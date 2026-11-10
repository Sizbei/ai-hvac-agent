import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { getViewerContext } from "@/lib/auth/viewer";
import { PREVIEW_COOKIE } from "@/lib/auth/preview-cookie";
import { getGoogleOidcConfig } from "@/lib/auth/google-oidc";
import { getOnboarding, patchOnboarding } from "@/lib/admin/onboarding-queries";
import { readAdminGuide } from "@/lib/admin/admin-guide-queries";
import { logAudit } from "@/lib/admin/audit";
import { isDemoOrg } from "@/lib/tenancy/demo-mode";
import {
  successResponse,
  errorResponse,
  readJsonBody,
} from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";

/**
 * GET — the setup guide payload for the session's org. Read-only while a
 * "View as" preview is on: no stamp, grandfathering or `firstSeenAt` write.
 * Any preview cookie on the request counts, even one the viewer could not
 * resolve, so a lookup error can never turn a preview read into a write.
 * `guide` (onboarding D1) is the viewer's own state, or the preview target's.
 */
export async function GET(request: NextRequest) {
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { session } = viewer;

    const rateCheck = slidingWindow(
      `admin:onboarding-get:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const demo = isDemoOrg(session.organizationId);
    const previewing = viewer.preview !== null || request.cookies.has(PREVIEW_COOKIE);
    const [payload, guide] = await Promise.all([
      getOnboarding(session.organizationId, {
        demo,
        write: !demo && !previewing,
        googleEnabled: getGoogleOidcConfig() !== null,
        appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
      }),
      // A separate read that never fails the checklist (spec D1): guide: null.
      readAdminGuide(viewer, { readOnly: previewing }).catch((error: unknown) => {
        logger.warn(
          { code: errorCode(error), organizationId: session.organizationId },
          "Admin guide read failed; returning guide: null",
        );
        return null;
      }),
    ]);
    return successResponse({ ...payload, guide });
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
