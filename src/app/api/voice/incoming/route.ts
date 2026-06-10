import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { customerSessions, messages, organizationSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { DEMO_ORG_ID } from "@/lib/tenancy/organization";
import { resolveTokenBudget, resolveMaxTurns } from "@/lib/ai/chat-limits";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { parseAndVerifyTwilioRequest, resolveVoiceMode } from "@/lib/voice/request";
import {
  gatherTwiML,
  sayThenHangupTwiML,
  hangupTwiML,
  POLLY_VOICE,
  TWIML_HEADERS,
} from "@/lib/voice/twiml";
import { logger } from "@/lib/logger";

const GREETING =
  "Thanks for calling. I'm the HVAC assistant. What issue are you having today?";

/**
 * Twilio inbound-call webhook. Verifies the request signature, creates a
 * `phone`-channel session keyed by the Twilio CallSid (so subsequent /gather
 * turns find it), and returns TwiML that greets the caller and gathers their
 * spoken response.
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const rate = slidingWindow(
    `voice:incoming:${ip}`,
    RATE_LIMITS.sessionCreate.maxRequests,
    RATE_LIMITS.sessionCreate.windowMs,
  );
  if (!rate.allowed) {
    // Twilio retries; a spoken apology is better than a bare 429 the caller
    // hears as dead air. (Polly here — no verified session yet, keep it cheap.)
    return new Response(
      sayThenHangupTwiML(
        "We're experiencing high call volume. Please try again shortly.",
        POLLY_VOICE,
      ),
      { headers: TWIML_HEADERS },
    );
  }

  const voice = resolveVoiceMode(request, Date.now());
  const { params, valid } = await parseAndVerifyTwilioRequest(request);
  if (!valid) {
    logger.warn({ ip }, "Rejected Twilio incoming webhook: invalid signature");
    return new Response("Forbidden", { status: 403 });
  }

  const callSid = params.CallSid;
  if (!callSid) {
    return new Response(hangupTwiML(), { headers: TWIML_HEADERS });
  }

  try {
    const organizationId = DEMO_ORG_ID;

    const [limitsRow] = await db
      .select({
        chatTokenBudget: organizationSettings.chatTokenBudget,
        chatMaxTurns: organizationSettings.chatMaxTurns,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1);

    await db
      .insert(customerSessions)
      .values({
        organizationId,
        // The Twilio CallSid is globally unique — use it as the session token so
        // later /gather turns in the same call resolve the session without an
        // extra mapping table.
        token: callSid,
        status: "chatting",
        channel: "phone",
        tokensUsed: 0,
        tokenBudget: resolveTokenBudget(limitsRow?.chatTokenBudget),
        turnCount: 0,
        maxTurns: resolveMaxTurns(limitsRow?.chatMaxTurns),
      })
      .onConflictDoNothing({ target: customerSessions.token });

    // Persist the greeting as the call's first assistant message. The LLM
    // fallback builds its context from message history — without this row it
    // believes no greeting happened and re-greets on its first turn. Guarded on
    // "no messages yet" so a Twilio retry of this webhook can't double-insert.
    const [sessionRow] = await db
      .select({ id: customerSessions.id })
      .from(customerSessions)
      .where(eq(customerSessions.token, callSid))
      .limit(1);
    const [existingMessage] = sessionRow
      ? await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.sessionId, sessionRow.id))
          .limit(1)
      : [];
    if (sessionRow && !existingMessage) {
      await db
        .insert(messages)
        .values({
          organizationId,
          sessionId: sessionRow.id,
          role: "assistant",
          content: GREETING,
          tokensUsed: 0,
        })
        .catch((e: unknown) =>
          logger.warn({ error: e, callSid }, "Greeting persist failed"),
        );
    }

    logger.info({ callSid }, "Phone session started");

    return new Response(
      gatherTwiML({
        say: GREETING,
        action: "/api/voice/gather",
        reprompt: "Sorry, I did not catch that. Please tell me what is going on with your heating or cooling.",
        voice,
      }),
      { headers: TWIML_HEADERS },
    );
  } catch (error) {
    logger.error({ error, callSid }, "Voice incoming failed");
    return new Response(
      sayThenHangupTwiML(
        "Sorry, something went wrong. Please call back in a moment.",
        voice,
      ),
      { headers: TWIML_HEADERS },
    );
  }
}
