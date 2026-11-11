/**
 * Technician getting-started guide (spec 2026-11-05).
 * GET   → the derived steps + progress for the session's technician (stamps new completions).
 * PATCH { hidden: true } → hides the jobs-list card for this technician (write-once).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import { previewWriteRefusal } from "@/lib/tech/preview-write-gate";
import { rateKeyFor } from "@/lib/tech/tech-preview";
import { getGuide, hideGuide } from "@/lib/tech/guide-queries";
import { isSameOriginRequest } from "@/lib/session-csrf";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { logger, errorCode } from "@/lib/logger";
import { getFeatures } from "@/lib/tenancy/features";

export const dynamic = "force-dynamic";

const patchSchema = z.strictObject({ hidden: z.literal(true) });

export async function GET() {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`tech:guide-get:${rateKeyFor(session)}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    // Copy only: a failed flag read must not break the guide, and "off" is the safe wording.
    const features = await getFeatures(session.organizationId).catch((error) => {
      logger.warn({ code: errorCode(error) }, "Feature read failed for the technician guide; using pay links off");
      return { payLinks: false };
    });
    // "View as" a technician is read-only: derive the steps, never stamp them.
    return successResponse(await getGuide(session.organizationId, session.userId, { features, write: !session.preview }));
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load the technician guide");
    return errorResponse("Couldn't load the guide.", "INTERNAL_ERROR", 500);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const previewRefused = previewWriteRefusal(session, request);
    if (previewRefused) return previewRefused;
    if (!isSameOriginRequest(request)) return errorResponse("Forbidden", "FORBIDDEN", 403);
    const rate = slidingWindow(`tech:guide-patch:${rateKeyFor(session)}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const body = await readJsonBody(request);
    const parsed = body.ok ? patchSchema.safeParse(body.data) : null;
    if (!parsed?.success) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const result = await hideGuide(session.organizationId, session.userId);
    if (!result) return errorResponse("Technician not found", "NOT_FOUND", 404);
    return successResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to update the technician guide");
    return errorResponse("Couldn't update the guide. Please try again.", "INTERNAL_ERROR", 500);
  }
}
