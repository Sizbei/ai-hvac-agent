import { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import { recordTechnicianLocation } from "@/lib/tech/location-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const fixSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  accuracyM: z.number().nullable().optional(),
  heading: z.number().nullable().optional(),
  capturedAt: z.string().datetime().optional(),
  serviceRequestId: z.string().uuid().nullable().optional(),
});

/**
 * POST /api/tech/location — ingest one live GPS fix from the technician's phone.
 * Technician session only; stored IFF the tech currently consents to location
 * sharing (enforced in recordTechnicianLocation → 403 when off). The client
 * coalesces fixes to ~60s, so the per-instance rate limit is a coarse backstop.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rate = slidingWindow(
      `tech:location:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = fixSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse("Invalid location fix", "VALIDATION_ERROR", 400);
    }

    // A GPS fix can't be from the future. A future-dated capturedAt (client clock
    // skew or forgery) would permanently become the "latest" fix — poisoning the
    // dispatch travel anchor and surviving the 30-day retention. Clamp anything
    // beyond a small skew tolerance to server time.
    const nowMs = Date.now();
    const rawMs = parsed.data.capturedAt
      ? new Date(parsed.data.capturedAt).getTime()
      : nowMs;
    const SKEW_TOLERANCE_MS = 2 * 60_000;
    const capturedAt = new Date(
      Number.isFinite(rawMs) && rawMs <= nowMs + SKEW_TOLERANCE_MS ? rawMs : nowMs,
    );

    const result = await recordTechnicianLocation(
      session.organizationId,
      session.userId,
      {
        latitude: parsed.data.latitude,
        longitude: parsed.data.longitude,
        accuracyM: parsed.data.accuracyM ?? null,
        heading: parsed.data.heading ?? null,
        capturedAt,
        serviceRequestId: parsed.data.serviceRequestId ?? null,
      },
    );

    if (!result.ok) {
      if (result.reason === "no_consent") {
        return errorResponse(
          "Location sharing is off",
          "NO_CONSENT",
          403,
        );
      }
      return errorResponse("Invalid location fix", "VALIDATION_ERROR", 400);
    }

    return successResponse({ ok: true });
  } catch (error) {
    logger.error({ error }, "Failed to record technician location");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
