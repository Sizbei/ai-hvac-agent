import { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import {
  getLocationConsent,
  setLocationConsent,
} from "@/lib/tech/location-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const consentSchema = z.object({ enabled: z.boolean() });

/** GET /api/tech/location/consent — the tech's current location-sharing choice. */
export async function GET() {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const enabled = await getLocationConsent(
      session.organizationId,
      session.userId,
    );
    return successResponse({ enabled });
  } catch (error) {
    logger.error({ error }, "Failed to read location consent");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

/** POST /api/tech/location/consent — turn location sharing on/off. Turning it
 *  off immediately stops ingestion (the ingest route re-checks per fix). */
export async function POST(request: NextRequest) {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const body: unknown = await request.json();
    const parsed = consentSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }
    await setLocationConsent(
      session.organizationId,
      session.userId,
      parsed.data.enabled,
    );
    return successResponse({ enabled: parsed.data.enabled });
  } catch (error) {
    logger.error({ error }, "Failed to update location consent");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
