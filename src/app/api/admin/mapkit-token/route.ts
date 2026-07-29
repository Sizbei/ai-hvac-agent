/**
 * GET /api/admin/mapkit-token — mint a short-lived ES256 JWT for MapKit JS.
 *
 * Admin-session-gated. Returns { token, expiresAt } where expiresAt is a Unix
 * timestamp (seconds). The JWT TTL is 30 minutes per Apple's recommendation.
 *
 * Required env vars (all three must be present or the endpoint returns 503):
 *   APPLE_TEAM_ID             — your 10-char Apple Developer team ID
 *   APPLE_MAPKIT_KEY_ID       — the key ID shown in Certificates, IDs & Profiles
 *   APPLE_MAPKIT_PRIVATE_KEY  — PKCS8 .p8 contents, \n-escaped (each newline → \\n)
 *
 * NEVER log or expose the private key.
 */
import { NextRequest } from "next/server";
import { SignJWT, importPKCS8 } from "jose";
import { getAdminSession } from "@/lib/auth/session";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const teamId = process.env.APPLE_TEAM_ID;
    const keyId = process.env.APPLE_MAPKIT_KEY_ID;
    const rawKey = process.env.APPLE_MAPKIT_PRIVATE_KEY;

    if (!teamId || !keyId || !rawKey) {
      return errorResponse(
        "MapKit JS credentials are not configured",
        "NOT_CONFIGURED",
        503,
      );
    }

    // Env vars store the key with literal \\n; restore real newlines before import.
    const pkcs8 = rawKey.replace(/\\n/g, "\n");
    const privateKey = await importPKCS8(pkcs8, "ES256");

    const origin = request.headers.get("origin") ?? "";
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 1800; // 30 minutes

    const token = await new SignJWT({ origin })
      .setProtectedHeader({ alg: "ES256", kid: keyId })
      .setIssuer(teamId)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(privateKey);

    return successResponse({ token, expiresAt: exp });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to mint MapKit token");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
