import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { isSameOriginRequest } from "@/lib/session-csrf";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { escalateSession } from "@/lib/ai/escalate-service";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const rateCheck = slidingWindow(
    `session:action:${ip}`,
    RATE_LIMITS.sessionAction.maxRequests,
    RATE_LIMITS.sessionAction.windowMs,
  );

  if (!rateCheck.allowed) {
    return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
  }

  // CSRF: the session cookie is SameSite=None (needed for the cross-site
  // iframe), so a forged cross-site POST would carry it. Only same-origin
  // requests (the legitimate /embed or /chat caller) may act on the session.
  if (!isSameOriginRequest(request)) {
    return errorResponse("Cross-origin request rejected", "FORBIDDEN_ORIGIN", 403);
  }

  try {
    const token = await getSessionToken();
    if (!token) {
      return errorResponse("No session found", "NO_SESSION", 401);
    }

    // Look up by the globally-unique session token; the org is taken from the
    // resolved session row and used to scope the escalation.
    const [session] = await db
      .select()
      .from(customerSessions)
      .where(eq(customerSessions.token, token))
      .limit(1);

    if (!session) {
      return errorResponse("Session not found", "SESSION_NOT_FOUND", 404);
    }

    const result = await escalateSession({
      organizationId: session.organizationId,
      sessionId: session.id,
      currentStatus: session.status,
      ipAddress: ip,
    });

    if (!result.ok) {
      return errorResponse(
        `Cannot escalate from state '${session.status}'`,
        "INVALID_STATE_TRANSITION",
        409,
      );
    }

    return successResponse({ status: "escalated" as const });
  } catch (error) {
    logger.error({ error }, "Failed to escalate session");
    return errorResponse("Failed to escalate", "ESCALATE_FAILED", 500);
  }
}
