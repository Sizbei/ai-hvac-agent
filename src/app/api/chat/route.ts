import { NextRequest } from "next/server";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
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
import { logger } from "@/lib/logger";

const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";
const MAX_TURNS = 15;

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
        "Guardrail flags detected",
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

    // 7. Build escalation hint if near turn limit per D-04
    const newTurnCount = session.turnCount + 1;
    const escalationHint =
      newTurnCount >= MAX_TURNS
        ? "\n\n[Note: This conversation has been going for a while. If you would prefer to speak with a human agent, you can request an escalation at any time.]"
        : "";

    // 8. Stream response via Vercel AI SDK per SC-09
    const result = streamText({
      model: openai("gpt-4o"),
      system: SYSTEM_PROMPT + escalationHint,
      messages: [
        ...conversationHistory.map((m) => ({
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

        // Update token usage and turn count
        const { newTotal } = addTokenUsage(
          session.tokensUsed,
          tokensThisCall,
          session.tokenBudget,
        );

        // Run extraction in background to determine state
        try {
          const extraction = await extractServiceRequest(
            conversationHistory,
            guardrailResult.sanitized,
          );
          const extractionComplete = isExtractionComplete(
            extraction.extraction,
          );
          const nextState = determineNextState(
            session.status,
            extractionComplete,
            newTurnCount,
            MAX_TURNS,
          );

          // Update session
          await db
            .update(customerSessions)
            .set({
              tokensUsed: newTotal,
              turnCount: newTurnCount,
              status: nextState,
              metadata: extractionComplete
                ? JSON.stringify(extraction.extraction)
                : session.metadata,
              updatedAt: new Date(),
            })
            .where(eq(customerSessions.id, session.id));
        } catch (extractionError) {
          // Extraction failure is non-fatal -- update tokens/turns but keep current state
          logger.error(
            { error: extractionError, sessionId: session.id },
            "Extraction failed",
          );
          await db
            .update(customerSessions)
            .set({
              tokensUsed: newTotal,
              turnCount: newTurnCount,
              updatedAt: new Date(),
            })
            .where(eq(customerSessions.id, session.id));
        }

        logger.info(
          {
            sessionId: session.id,
            tokensUsed: tokensThisCall,
            totalTokens: newTotal,
            turnCount: newTurnCount,
          },
          "Chat message processed",
        );
      },
    });

    return result.toTextStreamResponse();
  } catch (error) {
    logger.error({ error }, "Chat endpoint error");
    return errorResponse("Chat processing failed", "CHAT_FAILED", 500);
  }
}
