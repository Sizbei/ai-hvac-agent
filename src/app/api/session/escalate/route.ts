import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions, auditLog } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { successResponse, errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { transition } from "@/lib/ai/state-machine";
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

    const result = transition(session.status, "escalated");
    if (!result.success) {
      return errorResponse(
        `Cannot escalate from state '${session.status}'`,
        "INVALID_STATE_TRANSITION",
        409,
      );
    }

    await db
      .update(customerSessions)
      .set({ status: "escalated", updatedAt: new Date() })
      .where(eq(customerSessions.id, session.id));

    await db.insert(auditLog).values({
      organizationId: DEMO_ORG_ID,
      sessionId: session.id,
      action: "session_escalated",
      entity: "customer_sessions",
      entityId: session.id,
      ipAddress: ip,
    });

    logger.info({ sessionId: session.id }, "Session escalated to human");

    return successResponse({ status: "escalated" as const });
  } catch (error) {
    logger.error({ error }, "Failed to escalate session");
    return errorResponse("Failed to escalate", "ESCALATE_FAILED", 500);
  }
}
