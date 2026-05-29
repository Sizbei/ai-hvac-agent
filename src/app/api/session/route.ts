import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions, messages } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { successResponse, errorResponse } from "@/lib/api-response";
import {
  generateSessionToken,
  setSessionCookie,
  getSessionToken,
} from "@/lib/session";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

// Hard-coded demo org ID for Phase 1 (seeded in Plan 04)
// Phase 3 will derive org from domain/subdomain
const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const rateCheck = slidingWindow(
    `session:create:${ip}`,
    RATE_LIMITS.sessionCreate.maxRequests,
    RATE_LIMITS.sessionCreate.windowMs,
  );

  if (!rateCheck.allowed) {
    return errorResponse(
      "Rate limit exceeded. Please try again later.",
      "RATE_LIMITED",
      429,
    );
  }

  try {
    const token = generateSessionToken();

    const [session] = await db
      .insert(customerSessions)
      .values({
        organizationId: DEMO_ORG_ID,
        token,
        status: "chatting",
        tokensUsed: 0,
        tokenBudget: 10_000,
        turnCount: 0,
      })
      .returning();

    if (!session) {
      return errorResponse(
        "Failed to create session",
        "SESSION_CREATE_FAILED",
        500,
      );
    }

    await setSessionCookie(token);

    logger.info({ sessionId: session.id }, "Customer session created");

    return successResponse(
      {
        sessionId: session.id,
        status: session.status,
      },
      201,
    );
  } catch (error) {
    logger.error({ error }, "Failed to create session");
    return errorResponse(
      "Failed to create session",
      "SESSION_CREATE_FAILED",
      500,
    );
  }
}

export async function GET(_request: NextRequest) {
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

    // Get message history for this session
    const sessionMessages = await db
      .select()
      .from(messages)
      .where(
        withTenant(
          messages,
          DEMO_ORG_ID,
          eq(messages.sessionId, session.id),
        ),
      )
      .orderBy(messages.createdAt);

    return successResponse({
      sessionId: session.id,
      status: session.status,
      tokensUsed: session.tokensUsed,
      tokenBudget: session.tokenBudget,
      turnCount: session.turnCount,
      // Raw JSON string of extracted slots; the client parses it to drive the
      // confirmation card. Required for both the LLM and deterministic-router paths.
      metadata: session.metadata,
      messages: sessionMessages.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });
  } catch (error) {
    logger.error({ error }, "Failed to get session");
    return errorResponse(
      "Failed to retrieve session",
      "SESSION_GET_FAILED",
      500,
    );
  }
}
