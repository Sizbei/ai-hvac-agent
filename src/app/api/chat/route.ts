import { NextRequest } from "next/server";
import { streamText } from "ai";
import { getModel } from "@/lib/ai/provider";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions, messages } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { sanitizeInput } from "@/lib/ai/guardrails";
import {
  extractServiceRequest,
  type Message as AIMessage,
} from "@/lib/ai/extract";
import {
  determineNextState,
  isTerminalState,
} from "@/lib/ai/state-machine";
import { checkTokenBudget, addTokenUsage } from "@/lib/ai/token-budget";
import { isExtractionComplete } from "@/lib/ai/extraction-schema";
import { routeMessage } from "@/lib/ai/intent-router";
import { CONFIRM_REPLY } from "@/lib/ai/constants";
import { extractSlots } from "@/lib/ai/slot-extract";
import { escalateSession } from "@/lib/ai/escalate-service";
import {
  parseKnownSlots,
  mergeSlots,
  hasSlotData,
  buildExtraction,
} from "@/lib/ai/chat-slots";
import { logger } from "@/lib/logger";

const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";
const MAX_TURNS = 15;
// Sliding window of recent messages sent to the model (bounds context growth).
const MAX_HISTORY = 10;
// The deterministic router is on by default; set ROUTER_ENABLED=false to disable
// it (kill-switch) and route every turn through the LLM.
const ROUTER_ENABLED = process.env.ROUTER_ENABLED !== "false";

const ESCALATION_NOTE =
  "\n\nIf you'd prefer to speak with a human, you can tap “Talk to a Human” anytime.";

/** Single-chunk text/plain response — byte-compatible with the SDK's text stream. */
function cannedTextResponse(text: string): Response {
  return new Response(text, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Deterministic prompt for the next still-missing required slot. */
function nextSlotPrompt(slots: {
  readonly urgency?: unknown;
  readonly address?: unknown;
}): string {
  if (!slots.address) {
    return "Thanks! What's the service address where you'd like the technician to come?";
  }
  if (!slots.urgency) {
    return "Got it. How urgent is this — is it an emergency, or can it wait a little while?";
  }
  return "Thanks — could you share any other details that would help the technician?";
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const rateCheck = slidingWindow(
    `chat:${ip}`,
    RATE_LIMITS.chat.maxRequests,
    RATE_LIMITS.chat.windowMs,
  );

  if (!rateCheck.allowed) {
    return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
  }

  try {
    // 1. Validate session
    const token = await getSessionToken();
    if (!token) {
      return errorResponse(
        "No session found. Create a session first.",
        "NO_SESSION",
        401,
      );
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

    // 2. Check terminal state
    if (isTerminalState(session.status)) {
      return errorResponse(
        `Session is ${session.status}. No further messages allowed.`,
        "SESSION_TERMINATED",
        409,
      );
    }

    if (session.status === "submitted") {
      return errorResponse(
        "Session already submitted",
        "SESSION_SUBMITTED",
        409,
      );
    }

    // 3. Check token budget per D-07
    const budgetState = checkTokenBudget(
      session.tokensUsed,
      session.tokenBudget,
    );
    if (budgetState.exhausted) {
      return errorResponse(
        "Token budget exhausted for this session. Please start a new session or speak with a human.",
        "TOKEN_BUDGET_EXHAUSTED",
        429,
      );
    }

    // 4. Parse and sanitize message per SC-06
    const body: unknown = await request.json();
    const userMessage =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof (body as Record<string, unknown>).message === "string"
        ? ((body as Record<string, unknown>).message as string)
        : null;

    if (!userMessage || userMessage.trim().length === 0) {
      return errorResponse("Message is required", "INVALID_MESSAGE", 400);
    }

    const guardrailResult = sanitizeInput(userMessage);

    if (guardrailResult.flagged.length > 0) {
      logger.warn(
        { sessionId: session.id, flagged: guardrailResult.flagged },
        "Guardrail flags detected — blocking request",
      );
      return errorResponse(
        "Your message could not be processed. Please rephrase and try again.",
        "GUARDRAIL_BLOCKED",
        400,
      );
    }

    // 5. Load conversation history
    const history = await db
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

    const conversationHistory: AIMessage[] = history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // 6. Save user message
    await db.insert(messages).values({
      organizationId: DEMO_ORG_ID,
      sessionId: session.id,
      role: "user",
      content: guardrailResult.sanitized,
    });

    const newTurnCount = session.turnCount + 1;
    const nearTurnLimit = newTurnCount >= MAX_TURNS;

    // 7. Deterministic intent routing — answer/act on common messages with NO
    // LLM call. Falls back to the LLM for anything novel/ambiguous.
    const knownSlots = parseKnownSlots(session.metadata);
    if (ROUTER_ENABLED) {
      const verdict = routeMessage(guardrailResult.sanitized, knownSlots);
      const extracted = extractSlots(guardrailResult.sanitized);

      // A "slot provision" turn: we're mid-intake (issue already known) and the
      // customer just supplied an address/phone/email. There's no intent for a
      // bare address, so the router returns FALLBACK — but we can still fill the
      // slot deterministically instead of paying for an LLM call.
      const isSlotProvision =
        Boolean(knownSlots.issueType) &&
        Boolean(extracted.address || extracted.phone || extracted.email);

      if (verdict.action !== "FALLBACK_LLM" || isSlotProvision) {
        if (verdict.escalate) {
          const replyText =
            (verdict.reply ?? "") + (nearTurnLimit ? ESCALATION_NOTE : "");
          await db.insert(messages).values({
            organizationId: DEMO_ORG_ID,
            sessionId: session.id,
            role: "assistant",
            content: replyText,
            tokensUsed: 0,
          });
          const escResult = await escalateSession({
            organizationId: DEMO_ORG_ID,
            sessionId: session.id,
            currentStatus: session.status,
            ipAddress: ip,
          });
          if (!escResult.ok) {
            // Safety-critical: the audit trail must record the escalation.
            logger.error(
              { sessionId: session.id, reason: escResult.reason },
              "Deterministic escalation failed to apply",
            );
          }
          await db
            .update(customerSessions)
            .set({ turnCount: newTurnCount, updatedAt: new Date() })
            .where(eq(customerSessions.id, session.id));

          logger.info(
            {
              sessionId: session.id,
              routed: "deterministic",
              intentId: verdict.intentId,
              action: "ESCALATE",
              turnCount: newTurnCount,
            },
            "Chat turn resolved deterministically (0 LLM tokens)",
          );
          return cannedTextResponse(replyText);
        }

        // Merge router + regex-extracted slots into the session metadata.
        const merged = mergeSlots(knownSlots, {
          issueType: verdict.issueType ?? undefined,
          urgency: verdict.urgency ?? undefined,
          address: extracted.address ?? undefined,
          phone: extracted.phone ?? undefined,
          email: extracted.email ?? undefined,
        });

        let metadataStr = session.metadata;
        let extractionComplete = false;
        if (hasSlotData(merged)) {
          const firstUserMessage =
            conversationHistory.find((m) => m.role === "user")?.content ??
            guardrailResult.sanitized;
          const extraction = buildExtraction(
            merged,
            firstUserMessage.slice(0, 280),
          );
          extractionComplete = isExtractionComplete(extraction);
          metadataStr = JSON.stringify(extraction);
        }

        // Reply: confirm when complete, else the intent's canned ask, else a
        // deterministic next-slot prompt (slot-provision turns).
        const baseReply = extractionComplete
          ? CONFIRM_REPLY
          : verdict.action !== "FALLBACK_LLM" && verdict.reply
            ? verdict.reply
            : nextSlotPrompt(merged);
        const replyText = baseReply + (nearTurnLimit ? ESCALATION_NOTE : "");

        await db.insert(messages).values({
          organizationId: DEMO_ORG_ID,
          sessionId: session.id,
          role: "assistant",
          content: replyText,
          tokensUsed: 0,
        });

        const nextState = determineNextState(
          session.status,
          extractionComplete,
          newTurnCount,
          MAX_TURNS,
        );

        await db
          .update(customerSessions)
          .set({
            status: nextState,
            metadata: metadataStr,
            turnCount: newTurnCount,
            updatedAt: new Date(),
          })
          .where(eq(customerSessions.id, session.id));

        logger.info(
          {
            sessionId: session.id,
            routed: "deterministic",
            intentId: verdict.intentId,
            action: isSlotProvision && verdict.action === "FALLBACK_LLM"
              ? "SLOT_FILL"
              : verdict.action,
            confidence: Number(verdict.confidence.toFixed(2)),
            extractionComplete,
            turnCount: newTurnCount,
          },
          "Chat turn resolved deterministically (0 LLM tokens)",
        );

        return cannedTextResponse(replyText);
      }

      logger.info(
        { sessionId: session.id, routed: "llm", confidence: Number(verdict.confidence.toFixed(2)) },
        "Chat turn deferred to LLM",
      );
    }

    // 7b. Build escalation hint if near turn limit per D-04 (LLM path)
    const escalationHint = nearTurnLimit
      ? "\n\n[Note: This conversation has been going for a while. If you would prefer to speak with a human agent, you can request an escalation at any time.]"
      : "";

    // 8. Stream response via Vercel AI SDK per SC-09
    const result = streamText({
      model: getModel(),
      system: SYSTEM_PROMPT + escalationHint,
      // Cap output so replies stay short (the prompt asks for 2-3 sentences) and
      // tail costs are bounded (Token-Savings #6).
      maxOutputTokens: 350,
      messages: [
        // Sliding window: only send the most recent turns to bound the
        // quadratic token growth of full-history re-sends (Token-Savings #4).
        ...conversationHistory.slice(-MAX_HISTORY).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user" as const, content: guardrailResult.sanitized },
      ],
      onFinish: async ({ text, usage }) => {
        const tokensThisCall =
          (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);

        // Save assistant message
        await db.insert(messages).values({
          organizationId: DEMO_ORG_ID,
          sessionId: session.id,
          role: "assistant",
          content: text,
          tokensUsed: tokensThisCall,
        });

        // Update token usage and turn count immediately
        const { newTotal } = addTokenUsage(
          session.tokensUsed,
          tokensThisCall,
          session.tokenBudget,
        );

        await db
          .update(customerSessions)
          .set({
            tokensUsed: newTotal,
            turnCount: newTurnCount,
            updatedAt: new Date(),
          })
          .where(eq(customerSessions.id, session.id));

        logger.info(
          {
            sessionId: session.id,
            tokensUsed: tokensThisCall,
            totalTokens: newTotal,
            turnCount: newTurnCount,
          },
          "Chat message processed",
        );

        // Run extraction in background — don't block the response
        extractServiceRequest(conversationHistory, guardrailResult.sanitized)
          .then(async (extraction) => {
            // Re-read CURRENT metadata (not the request-time snapshot): a rapid
            // follow-up turn may have written new slots while extraction ran.
            // Merging against the snapshot would silently drop them.
            const [fresh] = await db
              .select({ metadata: customerSessions.metadata })
              .from(customerSessions)
              .where(eq(customerSessions.id, session.id));
            // Merge into any slots already known (deterministic or prior LLM
            // turns); never overwrite a filled slot with null.
            const merged = mergeSlots(parseKnownSlots(fresh?.metadata ?? null), {
              issueType: extraction.extraction.issueType ?? undefined,
              urgency: extraction.extraction.urgency ?? undefined,
              address: extraction.extraction.address ?? undefined,
              name: extraction.extraction.customerName ?? undefined,
              phone: extraction.extraction.customerPhone ?? undefined,
              email: extraction.extraction.customerEmail ?? undefined,
            });
            const firstUserMessage =
              conversationHistory.find((m) => m.role === "user")?.content ??
              guardrailResult.sanitized;
            const mergedExtraction = buildExtraction(
              merged,
              extraction.extraction.description || firstUserMessage.slice(0, 280),
            );
            const extractionComplete = isExtractionComplete(mergedExtraction);
            const nextState = determineNextState(
              session.status,
              extractionComplete,
              newTurnCount,
              MAX_TURNS,
            );

            await db
              .update(customerSessions)
              .set({
                status: nextState,
                metadata: hasSlotData(merged)
                  ? JSON.stringify(mergedExtraction)
                  : session.metadata,
                updatedAt: new Date(),
              })
              .where(eq(customerSessions.id, session.id));

            logger.info(
              { sessionId: session.id, extractionComplete },
              "Background extraction complete",
            );
          })
          .catch(async (extractionError: unknown) => {
            logger.error(
              { error: extractionError, sessionId: session.id },
              "Background extraction failed",
            );
            // Ensure session state stays consistent even if extraction fails
            const fallbackState = determineNextState(
              session.status,
              false,
              newTurnCount,
              MAX_TURNS,
            );
            await db
              .update(customerSessions)
              .set({ status: fallbackState, updatedAt: new Date() })
              .where(eq(customerSessions.id, session.id))
              .catch(() => {});
          });
      },
    });

    return result.toTextStreamResponse();
  } catch (error) {
    logger.error({ error }, "Chat endpoint error");
    return errorResponse("Chat processing failed", "CHAT_FAILED", 500);
  }
}
