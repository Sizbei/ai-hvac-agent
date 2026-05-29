import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { successResponse, errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { escalateSession } from "@/lib/ai/escalate-service";
import { logger } from "@/lib/logger";

const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";

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

    const [session] = await db
      .select()
      .from(customerSessions)
      .where(
        withTenant(
          customerSessions,
          DEMO_ORG_ID,
          eq(customerSessions.token, token),
        ),
      );

    if (!session) {
      return errorResponse("Session not found", "SESSION_NOT_FOUND", 404);
    }

    const result = await escalateSession({
      organizationId: DEMO_ORG_ID,
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
