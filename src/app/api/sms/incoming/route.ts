import { NextRequest, after } from "next/server";
import { db } from "@/lib/db";
import {
  customerSessions,
  messages,
  organizationSettings,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db/tenant";
import { DEMO_ORG_ID } from "@/lib/tenancy/organization";
import { resolveTokenBudget, resolveMaxTurns } from "@/lib/ai/chat-limits";
import { isTerminalState, type SessionState } from "@/lib/ai/state-machine";
import { voiceReply } from "@/lib/ai/voice-turn";
import { compactSessionIfNeeded } from "@/lib/ai/compact-session";
import { type ChatTurn } from "@/lib/ai/compaction";
import { sanitizeInput } from "@/lib/ai/guardrails";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { parseAndVerifyTwilioRequest } from "@/lib/voice/request";
import { messagingTwiML, emptyMessagingTwiML, MESSAGING_HEADERS } from "@/lib/sms/twiml";
import {
  classifySmsKeyword,
  setDoNotContactByPhone,
} from "@/lib/communication/consent";
import { logger } from "@/lib/logger";

// CTIA-compliant replies for the carrier opt-out keywords.
const STOP_REPLY =
  "You're unsubscribed and won't receive more messages. Reply START to resubscribe.";
const START_REPLY = "You're resubscribed and will receive messages again.";
const HELP_REPLY =
  "HVAC assistant. Reply with your service question, or STOP to unsubscribe. Msg & data rates may apply.";

const GREETING =
  "Thanks for texting. I'm the HVAC assistant. What issue are you having today?";

const BUSY_REPLY =
  "We're handling a lot of messages right now. Please text again in a moment.";

const ERROR_REPLY =
  "Sorry, something went wrong on our end. Please text us again in a moment.";

/**
 * Twilio inbound-SMS webhook. Verifies the request signature, resolves (or
 * creates) a `phone`-channel session keyed by the sender's number, runs the
 * message body through the same sub-agent the voice channel uses, and returns
 * messaging TwiML with the reply.
 *
 * `voiceReply` is channel-agnostic — it produces a text reply plus the next
 * session state, and persists the user/assistant messages itself, so this route
 * must not insert them again.
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";

  // Verify the Twilio signature FIRST so compliance keywords (STOP) are honored
  // even under load — a STOP must never be dropped by the rate limiter.
  const { params, valid } = await parseAndVerifyTwilioRequest(request);
  if (!valid) {
    logger.warn({ ip }, "Rejected Twilio SMS webhook: invalid signature");
    return new Response("Forbidden", { status: 403 });
  }

  // Twilio posts the sender as `From` and the text as `Body`.
  const from = (params.From ?? "").trim();
  const body = (params.Body ?? "").trim();

  if (!from) {
    return new Response(messagingTwiML(ERROR_REPLY), {
      headers: MESSAGING_HEADERS,
    });
  }

  const organizationId = DEMO_ORG_ID;

  // COMPLIANCE: STOP/HELP/START handled BEFORE the rate limiter and the AI brain
  // — an inbound "STOP" must suppress the contact and get the standard opt-out
  // reply, never be throttled or answered conversationally.
  const keyword = classifySmsKeyword(body);
  if (keyword === "stop") {
    await setDoNotContactByPhone(organizationId, from, true);
    logger.info({ from }, "SMS opt-out (STOP)");
    return new Response(messagingTwiML(STOP_REPLY), { headers: MESSAGING_HEADERS });
  }
  if (keyword === "start") {
    await setDoNotContactByPhone(organizationId, from, false);
    logger.info({ from }, "SMS opt-in (START)");
    return new Response(messagingTwiML(START_REPLY), { headers: MESSAGING_HEADERS });
  }
  if (keyword === "help") {
    return new Response(messagingTwiML(HELP_REPLY), { headers: MESSAGING_HEADERS });
  }

  // Rate limit normal conversational messages.
  const rate = slidingWindow(
    `sms:incoming:${ip}`,
    RATE_LIMITS.chat.maxRequests,
    RATE_LIMITS.chat.windowMs,
  );
  if (!rate.allowed) {
    // Twilio retries on 5xx; a plain reply is friendlier than dead air.
    return new Response(messagingTwiML(BUSY_REPLY), {
      headers: MESSAGING_HEADERS,
    });
  }

  try {
    // Key the session on the sender's number so subsequent texts in the same
    // conversation resolve the same session — the SMS analogue of CallSid.
    const sessionToken = `sms:${from}`;

    let [session] = await db
      .select()
      .from(customerSessions)
      .where(eq(customerSessions.token, sessionToken))
      .limit(1);

    // First message from this number, or the prior conversation already closed:
    // start a fresh session and greet.
    if (!session || isTerminalState(session.status) || session.status === "submitted") {
      const [limitsRow] = await db
        .select({
          chatTokenBudget: organizationSettings.chatTokenBudget,
          chatMaxTurns: organizationSettings.chatMaxTurns,
        })
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId))
        .limit(1);

      if (session) {
        // Prior conversation is over — retire the stale token so the new
        // session can reuse the number as its key.
        await db
          .update(customerSessions)
          .set({ token: `${sessionToken}:${session.id}` })
          .where(eq(customerSessions.id, session.id));
      }

      await db
        .insert(customerSessions)
        .values({
          organizationId,
          token: sessionToken,
          status: "chatting",
          channel: "sms",
          tokensUsed: 0,
          tokenBudget: resolveTokenBudget(limitsRow?.chatTokenBudget),
          turnCount: 0,
          maxTurns: resolveMaxTurns(limitsRow?.chatMaxTurns),
        })
        .onConflictDoNothing({ target: customerSessions.token });

      [session] = await db
        .select()
        .from(customerSessions)
        .where(eq(customerSessions.token, sessionToken))
        .limit(1);

      logger.info({ from }, "SMS session started");

      // No body on the opening text (e.g. an empty MMS) — greet and wait.
      if (body.length === 0) {
        return new Response(messagingTwiML(GREETING), {
          headers: MESSAGING_HEADERS,
        });
      }
    }

    if (!session) {
      return new Response(messagingTwiML(ERROR_REPLY), {
        headers: MESSAGING_HEADERS,
      });
    }

    // Empty body on an existing conversation — nudge without consuming a turn.
    if (body.length === 0) {
      return new Response(
        messagingTwiML("Sorry, I didn't catch that. Could you tell me what's going on?"),
        { headers: MESSAGING_HEADERS },
      );
    }

    const sanitized = sanitizeInput(body);

    // Stage 4: if a human CSR has taken over this thread (mode='human'), the bot
    // must NOT auto-reply. Persist the inbound message so it shows in the inbox,
    // then return empty TwiML — the CSR replies from the admin inbox. Checked
    // BEFORE the AI brain so the human always wins the race.
    if (session.mode === "human") {
      await db.insert(messages).values({
        organizationId,
        sessionId: session.id,
        role: "user",
        content: sanitized.sanitized,
      });
      // Empty <Response/> (no <Message>) so Twilio sends NO auto-reply — the CSR
      // owns the thread now.
      return new Response(emptyMessagingTwiML(), { headers: MESSAGING_HEADERS });
    }

    const history = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(
        withTenant(messages, organizationId, eq(messages.sessionId, session.id)),
      )
      .orderBy(messages.createdAt);

    const chatHistory: ChatTurn[] = history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as ChatTurn["role"], content: m.content }));

    const result = await voiceReply({
      session: {
        id: session.id,
        organizationId,
        status: session.status as SessionState,
        turnCount: session.turnCount,
        maxTurns: session.maxTurns,
        metadata: session.metadata,
        runningSummary: session.runningSummary,
      },
      history: chatHistory,
      userMessage: sanitized.sanitized,
      ipAddress: ip,
    });

    // Compaction runs in the background so long text threads stay coherent
    // without re-sending the transcript each turn.
    after(async () => {
      try {
        await compactSessionIfNeeded({
          sessionId: session.id,
          organizationId,
          history: [...chatHistory, { role: "user", content: sanitized.sanitized }],
        });
      } catch (e) {
        logger.error({ error: e, sessionId: session.id }, "SMS compaction failed");
      }
    });

    return new Response(messagingTwiML(result.reply), {
      headers: MESSAGING_HEADERS,
    });
  } catch (error) {
    logger.error({ error, from }, "SMS incoming failed");
    return new Response(messagingTwiML(ERROR_REPLY), {
      headers: MESSAGING_HEADERS,
    });
  }
}
