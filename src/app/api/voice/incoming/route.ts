import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { customerSessions, organizationSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { DEMO_ORG_ID } from "@/lib/tenancy/organization";
import { resolveTokenBudget, resolveMaxTurns } from "@/lib/ai/chat-limits";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { parseAndVerifyTwilioRequest } from "@/lib/voice/request";
import {
  gatherTwiML,
  sayThenHangupTwiML,
  hangupTwiML,
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
    // hears as dead air.
    return new Response(
      sayThenHangupTwiML("We're experiencing high call volume. Please try again shortly."),
      { headers: TWIML_HEADERS },
    );
  }

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

    logger.info({ callSid }, "Phone session started");

    return new Response(
      gatherTwiML({
        say: GREETING,
        action: "/api/voice/gather",
        reprompt: "Sorry, I did not catch that. Please tell me what is going on with your heating or cooling.",
      }),
      { headers: TWIML_HEADERS },
    );
  } catch (error) {
    logger.error({ error, callSid }, "Voice incoming failed");
    return new Response(
      sayThenHangupTwiML("Sorry, something went wrong. Please call back in a moment."),
      { headers: TWIML_HEADERS },
    );
  }
}
