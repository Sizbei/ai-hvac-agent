import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customerSessions,
  messages,
  organizationSettings,
  attachments,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { successResponse, errorResponse } from "@/lib/api-response";
import {
  generateSessionToken,
  setSessionCookie,
  getSessionToken,
} from "@/lib/session";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import {
  resolveOrganizationForSession,
  organizationIdForPublishableKey,
} from "@/lib/tenancy/organization";
import { touchKeyLastUsed } from "@/lib/widget/key-queries";
import { resolveTokenBudget, resolveMaxTurns } from "@/lib/ai/chat-limits";
import {
  buildWelcomeMessage,
  brandInfoFromConfig,
} from "@/lib/ai/system-prompt";
import { getRouterConfig } from "@/lib/admin/org-config-queries";
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

    // Resolve the org's configured conversation limits (or the system defaults)
    // and stamp them onto the session so the chat hot path reads them off the
    // loaded row. A missing/blank value falls back to the default via resolve*.
    const [limitsRow] = await db
      .select({
        chatTokenBudget: organizationSettings.chatTokenBudget,
        chatMaxTurns: organizationSettings.chatMaxTurns,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1);

    const tokenBudget = resolveTokenBudget(limitsRow?.chatTokenBudget);
    const maxTurns = resolveMaxTurns(limitsRow?.chatMaxTurns);

    const token = generateSessionToken();

    const [session] = await db
      .insert(customerSessions)
      .values({
        organizationId,
        token,
        status: "chatting",
        tokensUsed: 0,
        tokenBudget,
        turnCount: 0,
        maxTurns,
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

    // Persist the org-branded greeting as the FIRST assistant message (parity
    // with the voice channel, which persists its spoken greeting at call
    // start). This makes the welcome a real transcript message: the UI renders
    // it from session data instead of a client-side phantom that vanished once
    // the customer replied, a refresh rehydrates it, and the LLM sees an
    // assistant reply already exists so it never greets a second time.
    // Best-effort — a failure here must not fail session creation.
    let greeting: string | null = null;
    try {
      const config = await getRouterConfig(organizationId);
      greeting = buildWelcomeMessage(
        brandInfoFromConfig(config.companyName, config.businessInfo),
      );
      await db.insert(messages).values({
        organizationId,
        sessionId: session.id,
        role: "assistant",
        content: greeting,
        tokensUsed: 0,
      });
    } catch (greetError: unknown) {
      logger.error(
        { error: greetError, sessionId: session.id },
        "Failed to persist session greeting (non-fatal)",
      );
      greeting = null;
    }

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
        // The persisted welcome copy, so the client can seed its transcript
        // without a second round-trip. Null if persistence failed (the client
        // falls back to its generic copy).
        greeting,
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

export async function GET(request: NextRequest) {
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

    // Cross-org resume guard: if a widget key is present, the session may only be
    // resumed when the key maps to the SAME org — a stale cookie from org A must
    // not be rehydrated inside org B's embedded widget (misattributing every new
    // message to org A). FAIL CLOSED: an invalid/unknown key or a mismatch both
    // yield NO_SESSION so the client falls through to createSession() for the
    // correct org. Compared key→org ONLY (no origin allowlist) — a same-origin
    // resume GET carries no Origin header, so an origin check here would wrongly
    // skip the guard for every allowlisted org. No key (hosted /chat) → resume.
    const widgetKey = request.headers.get("x-hvac-widget-key");
    if (widgetKey) {
      const keyOrg = await organizationIdForPublishableKey(widgetKey);
      if (keyOrg !== session.organizationId) {
        return errorResponse("No session for this widget", "NO_SESSION", 401);
      }
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

    // Get attachments for this session, scoped to the session's own org.
    const sessionAttachments = await db
      .select()
      .from(attachments)
      .where(
        withTenant(
          attachments,
          session.organizationId,
          eq(attachments.sessionId, session.id),
        ),
      )
      .orderBy(attachments.createdAt);

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
      // Attachments for this session, grouped by message ID
      attachments: sessionAttachments.map((a) => ({
        id: a.id,
        messageId: a.messageId,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        url: `${process.env.R2_PUBLIC_URL}/${a.storageKey}`,
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
