import { NextRequest, after } from "next/server";
import { db } from "@/lib/db";
import { customerSessions, messages, organizationSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db/tenant";
import { isTerminalState, type SessionState } from "@/lib/ai/state-machine";
import { voiceReply } from "@/lib/ai/voice-turn";
import { compactSessionIfNeeded } from "@/lib/ai/compact-session";
import { type ChatTurn } from "@/lib/ai/compaction";
import { sanitizeInput } from "@/lib/ai/guardrails";
import { parseAndVerifyTwilioRequest, resolveVoiceMode } from "@/lib/voice/request";
import {
  gatherTwiML,
  sayThenHangupTwiML,
  dialThenHangupTwiML,
  hangupTwiML,
  TWIML_HEADERS,
} from "@/lib/voice/twiml";
import { logger } from "@/lib/logger";

/**
 * Twilio speech-gather webhook. Verifies the signature, loads the phone session
 * by CallSid, runs the recognized speech through the phone sub-agent, and
 * returns TwiML that speaks the reply and gathers the next turn — or, on a
 * terminal/confirmed state, speaks a closing line and hangs up.
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const voice = resolveVoiceMode(request, Date.now());

  const { params, valid } = await parseAndVerifyTwilioRequest(request);
  if (!valid) {
    logger.warn({ ip }, "Rejected Twilio gather webhook: invalid signature");
    return new Response("Forbidden", { status: 403 });
  }

  const callSid = params.CallSid;
  const speech = (params.SpeechResult ?? "").trim();

  if (!callSid) {
    return new Response(hangupTwiML(), { headers: TWIML_HEADERS });
  }

  try {
    const [session] = await db
      .select()
      .from(customerSessions)
      .where(eq(customerSessions.token, callSid))
      .limit(1);

    if (!session) {
      return new Response(
        sayThenHangupTwiML(
          "Sorry, I lost track of this call. Please call back.",
          voice,
        ),
        { headers: TWIML_HEADERS },
      );
    }

    // Already escalated/terminal — don't keep the automated leg running. A
    // SUBMITTED session gets a closing line that confirms the request is in
    // (the caller may have said "yes, one more thing" — the team handles it).
    if (isTerminalState(session.status) || session.status === "submitted") {
      return new Response(
        sayThenHangupTwiML(
          session.status === "submitted"
            ? "Your request is in with our team and they'll follow up with you shortly. Thanks for calling. Goodbye."
            : "Thanks for calling. Goodbye.",
          voice,
        ),
        { headers: TWIML_HEADERS },
      );
    }

    // No recognized speech — re-prompt without consuming a turn.
    if (speech.length === 0) {
      return new Response(
        gatherTwiML({
          say: "I'm sorry, I didn't hear anything. Could you tell me what's going on?",
          action: "/api/voice/gather",
          voice,
        }),
        { headers: TWIML_HEADERS },
      );
    }

    const sanitized = sanitizeInput(speech);
    const organizationId = session.organizationId;

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

    // Compaction runs in the background (same model as web), bounded so long
    // calls stay coherent without re-sending the transcript each turn.
    after(async () => {
      try {
        await compactSessionIfNeeded({
          sessionId: session.id,
          organizationId,
          history: [...chatHistory, { role: "user", content: sanitized.sanitized }],
        });
      } catch (e) {
        logger.error({ error: e, sessionId: session.id }, "Voice compaction failed");
      }
    });

    if (result.endCall) {
      // Stage 2: warm-transfer an ESCALATED call to a human via <Dial> when a
      // transfer number is configured — instead of just hanging up. Falls back
      // to a spoken message + hangup when no number is set or no one answers.
      if (result.nextState === "escalated") {
        const [orgRow] = await db
          .select({ voiceTransferNumber: organizationSettings.voiceTransferNumber })
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, organizationId))
          .limit(1);
        const transferNumber = orgRow?.voiceTransferNumber?.trim();
        if (transferNumber) {
          return new Response(
            dialThenHangupTwiML({
              say: result.reply,
              number: transferNumber,
              fallback:
                "I'm sorry, no one is available right now. We'll call you back as soon as possible.",
              voice,
            }),
            { headers: TWIML_HEADERS },
          );
        }
      }
      return new Response(sayThenHangupTwiML(result.reply, voice), {
        headers: TWIML_HEADERS,
      });
    }

    return new Response(
      gatherTwiML({ say: result.reply, action: "/api/voice/gather", voice }),
      { headers: TWIML_HEADERS },
    );
  } catch (error) {
    logger.error({ error, callSid }, "Voice gather failed");
    return new Response(
      sayThenHangupTwiML(
        "Sorry, something went wrong on our end. Please call back.",
        voice,
      ),
      { headers: TWIML_HEADERS },
    );
  }
}
