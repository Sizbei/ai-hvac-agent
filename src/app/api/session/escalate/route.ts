import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { escalateSession } from "@/lib/ai/escalate-service";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const rateCheck = slidingWindow(
    `session:action:${ip}`,
    RATE_LIMITS.sessionAction.maxRequests,
    RATE_LIMITS.sessionAction.windowMs,
  );

  if (!rateCheck.allowed) {
    return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
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
