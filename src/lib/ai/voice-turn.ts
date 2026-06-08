/**
 * Phone turn orchestration.
 *
 * Runs one caller utterance through the SAME deterministic router + slot
 * extraction + state machine the web chat uses, then shapes the result for
 * text-to-speech. Returns a complete spoken reply (not a stream — a phone
 * caller needs one finished utterance) plus whether the call should end.
 *
 * Persistence (message rows, session metadata/turn count) happens here so the
 * voice route stays a thin TwiML adapter. The heavy lifting (intent matching,
 * extraction schema) is delegated to the shared lib — this is a voice persona
 * over the proven core, not a second brain.
 */
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions, messages } from "@/lib/db/schema";
import { getModel } from "./provider";
import { routeMessage } from "./intent-router";
import { extractSlots } from "./slot-extract";
import { getRouterConfig } from "@/lib/admin/org-config-queries";
import { EMPTY_ORG_CONFIG } from "./router-config";
import { escalateSession } from "./escalate-service";
import {
  parseKnownSlots,
  mergeSlots,
  hasSlotData,
  buildExtraction,
} from "./chat-slots";
import { isExtractionComplete } from "./extraction-schema";
import { determineNextState, type SessionState } from "./state-machine";
import { PHONE_SYSTEM_PROMPT, toSpokenReply, voiceNextSlotPrompt } from "./phone-agent";
import { nextTriageStep, captureEnrichmentAnswer } from "./triage";
import { buildModelMessages, MAX_HISTORY, type ChatTurn } from "./compaction";
import { logger } from "@/lib/logger";

/** Spoken equivalent of CONFIRM_REPLY — no "tap a button" affordance. */
export const VOICE_CONFIRM_REPLY =
  "Great — I have everything I need. I'll get this over to our team and a technician will be in touch to schedule. Is there anything else I can help you with?";

export interface VoiceSession {
  readonly id: string;
  readonly organizationId: string;
  readonly status: SessionState;
  readonly turnCount: number;
  readonly maxTurns: number;
  readonly metadata: string | null;
  readonly runningSummary?: string | null;
}

export interface VoiceReplyResult {
  /** The spoken text to read to the caller. */
  readonly reply: string;
  /** True when the call should be hung up after this reply (terminal state). */
  readonly endCall: boolean;
  /** The session state after this turn. */
  readonly nextState: SessionState;
}

export async function voiceReply(params: {
  readonly session: VoiceSession;
  readonly history: readonly ChatTurn[];
  readonly userMessage: string;
  readonly ipAddress: string;
}): Promise<VoiceReplyResult> {
  const { session, history, userMessage, ipAddress } = params;
  const organizationId = session.organizationId;
  const sessionScope = and(
    eq(customerSessions.id, session.id),
    eq(customerSessions.organizationId, organizationId),
  );
  const newTurnCount = session.turnCount + 1;
  const nearLimit = newTurnCount >= session.maxTurns;

  // Persist the caller's turn.
  await db.insert(messages).values({
    organizationId,
    sessionId: session.id,
    role: "user",
    content: userMessage,
  });

  const knownSlots = parseKnownSlots(session.metadata);
  const routerConfig = await getRouterConfig(organizationId).catch(
    () => EMPTY_ORG_CONFIG,
  );
  const verdict = routeMessage(userMessage, knownSlots, routerConfig);
  const extracted = extractSlots(userMessage);

  // Capture a bare enrichment answer (the spoken-back chip value) into extras,
  // mirroring the web chat — so phone enrichment answers actually persist
  // instead of being spoken into the void.
  const pendingStep = nextTriageStep({
    issueType: knownSlots.issueType ?? null,
    urgency: knownSlots.urgency ?? null,
    address: knownSlots.address ?? null,
    phone: knownSlots.phone ?? null,
    safetyScreenPassed: true,
    extras: { ...(knownSlots.extras ?? {}) },
  });
  const captured = captureEnrichmentAnswer(pendingStep?.id ?? null, userMessage);
  const capturedExtras = captured ? { [captured.key]: captured.value } : undefined;

  const hasContactSlot = Boolean(
    extracted.address || extracted.phone || extracted.email,
  );
  const isSlotProvision =
    hasContactSlot && (Boolean(knownSlots.issueType) || history.length > 0);

  // ── Emergency / escalation ──
  if (verdict.action !== "FALLBACK_LLM" || isSlotProvision) {
    if (verdict.escalate) {
      const reply = toSpokenReply(verdict.reply ?? "", { nearLimit });
      await db.insert(messages).values({
        organizationId,
        sessionId: session.id,
        role: "assistant",
        content: reply,
        tokensUsed: 0,
      });
      await escalateSession({
        organizationId,
        sessionId: session.id,
        currentStatus: session.status,
        ipAddress,
      }).catch((e: unknown) =>
        logger.error({ error: e, sessionId: session.id }, "voice escalate failed"),
      );

      const escMerged = mergeSlots(knownSlots, {
        issueType: verdict.issueType ?? undefined,
        urgency: verdict.urgency ?? undefined,
        address: extracted.address ?? undefined,
        phone: extracted.phone ?? undefined,
        email: extracted.email ?? undefined,
      });
      await db
        .update(customerSessions)
        .set({
          metadata: hasSlotData(escMerged)
            ? JSON.stringify(buildExtraction(escMerged, userMessage.slice(0, 280)))
            : session.metadata,
          turnCount: newTurnCount,
          updatedAt: new Date(),
        })
        .where(sessionScope);

      // An escalated call is handed to a human — end the automated leg.
      return { reply, endCall: true, nextState: "escalated" };
    }

    // ── Deterministic answer / slot fill ──
    const merged = mergeSlots(knownSlots, {
      issueType: verdict.issueType ?? undefined,
      urgency: verdict.urgency ?? undefined,
      address: extracted.address ?? undefined,
      phone: extracted.phone ?? undefined,
      email: extracted.email ?? undefined,
      extras: capturedExtras,
    });

    let metadataStr = session.metadata;
    let extractionComplete = false;
    if (hasSlotData(merged)) {
      const firstUser =
        history.find((m) => m.role === "user")?.content ?? userMessage;
      const extraction = buildExtraction(merged, firstUser.slice(0, 280));
      extractionComplete = isExtractionComplete(extraction);
      metadataStr = JSON.stringify(extraction);
    }

    const baseReply = extractionComplete
      ? VOICE_CONFIRM_REPLY
      : verdict.action !== "FALLBACK_LLM" && verdict.reply
        ? verdict.reply
        : voiceNextSlotPrompt(merged);
    const reply = toSpokenReply(baseReply, { nearLimit });

    await db.insert(messages).values({
      organizationId,
      sessionId: session.id,
      role: "assistant",
      content: reply,
      tokensUsed: 0,
    });

    const nextState = determineNextState(
      session.status,
      extractionComplete,
      newTurnCount,
      session.maxTurns,
    );

    await db
      .update(customerSessions)
      .set({
        status: nextState,
        metadata: metadataStr,
        turnCount: newTurnCount,
        updatedAt: new Date(),
      })
      .where(sessionScope);

    return { reply, endCall: false, nextState };
  }

  // ── LLM fallback (non-streaming: a phone reply must be a complete utterance) ──
  const modelMessages = buildModelMessages({
    runningSummary: session.runningSummary ?? null,
    recent: history.slice(-MAX_HISTORY),
    current: userMessage,
  }).map((m) => ({ role: m.role, content: m.content }));

  const { text, usage } = await generateText({
    model: getModel(),
    system: PHONE_SYSTEM_PROMPT,
    messages: modelMessages,
  });

  const reply = toSpokenReply(text, { nearLimit });
  const tokensThisCall =
    (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);

  await db.insert(messages).values({
    organizationId,
    sessionId: session.id,
    role: "assistant",
    content: reply,
    tokensUsed: tokensThisCall,
  });

  const nextState = determineNextState(
    session.status,
    false,
    newTurnCount,
    session.maxTurns,
  );

  await db
    .update(customerSessions)
    .set({ status: nextState, turnCount: newTurnCount, updatedAt: new Date() })
    .where(sessionScope);

  return { reply, endCall: false, nextState };
}
