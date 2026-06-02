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
import { resolveOrganizationForSession } from "@/lib/tenancy/organization";
import { touchKeyLastUsed } from "@/lib/widget/key-queries";
import { logger } from "@/lib/logger";

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
    // Resolve which organization this chat belongs to. For an embedded widget,
    // the publishable key arrives in the X-HVAC-Widget-Key header; the hosted
    // demo page sends none and resolves to the demo org. The resolved org is
    // PERSISTED on the session; every later request reads it back from the
    // session row rather than re-resolving, so the chat can't be re-attributed.
    const resolution = await resolveOrganizationForSession({
      publishableKey: request.headers.get("x-hvac-widget-key"),
      origin: request.headers.get("origin"),
    });

    if (!resolution.ok) {
      const message =
        resolution.reason === "origin_not_allowed"
          ? "This domain is not allowed to use this widget."
          : "Invalid widget key.";
      return errorResponse(message, "WIDGET_NOT_AUTHORIZED", 403);
    }

    const { organizationId } = resolution;

    const token = generateSessionToken();

    const [session] = await db
      .insert(customerSessions)
      .values({
        organizationId,
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

    // Best-effort: record that the widget key was used (so admins can spot
    // dormant keys). Never block or fail the session on this.
    if (resolution.widgetKeyId) {
      void touchKeyLastUsed(resolution.widgetKeyId).catch(() => {});
    }

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

    // The session token is a globally-unique, unguessable UUID delivered via an
    // httpOnly cookie — it IS the session's auth, so look up by token alone.
    // The org is then taken from the row (session.organizationId) and used to
    // scope every related read.
    const [session] = await db
      .select()
      .from(customerSessions)
      .where(eq(customerSessions.token, token))
      .limit(1);

    if (!session) {
      return errorResponse("Session not found", "SESSION_NOT_FOUND", 404);
    }

    // Get message history for this session, scoped to the session's own org.
    const sessionMessages = await db
      .select()
      .from(messages)
      .where(
        withTenant(
          messages,
          session.organizationId,
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
