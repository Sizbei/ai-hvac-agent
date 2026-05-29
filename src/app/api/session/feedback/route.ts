import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { customerSessions, auditLog } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { successResponse, errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";

const feedbackSchema = z.object({
  vote: z.enum(["up", "down"]),
  messageIndex: z.number().int().min(0).max(1000),
  intentId: z.string().max(120).optional(),
});

/**
 * Records a customer's 👍/👎 on an assistant message. Stored in the audit log
 * (no schema change needed) so we can measure deflection quality / FAQ accuracy
 * in the admin AI Insights view.
 */
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

    const body: unknown = await request.json();
    const parsed = feedbackSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse("Invalid feedback", "VALIDATION_ERROR", 400);
    }

    await db.insert(auditLog).values({
      organizationId: DEMO_ORG_ID,
      sessionId: session.id,
      action: "message_feedback",
      entity: "messages",
      entityId: session.id,
      details: JSON.stringify({
        vote: parsed.data.vote,
        messageIndex: parsed.data.messageIndex,
        intentId: parsed.data.intentId ?? null,
      }),
      ipAddress: ip,
    });

    logger.info(
      { sessionId: session.id, vote: parsed.data.vote },
      "Message feedback recorded",
    );

    return successResponse({ ok: true as const });
  } catch (error) {
    logger.error({ error }, "Failed to record feedback");
    return errorResponse("Failed to record feedback", "FEEDBACK_FAILED", 500);
  }
}
