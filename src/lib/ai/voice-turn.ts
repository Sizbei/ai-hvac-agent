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
import { extractSlots, extractAddressAtAddressStep } from "./slot-extract";
import { getRouterConfig } from "@/lib/admin/org-config-queries";
import { EMPTY_ORG_CONFIG } from "./router-config";
import { escalateSession } from "./escalate-service";
import {
  parseKnownSlots,
  mergeSlots,
  hasSlotData,
  buildExtraction,
} from "./chat-slots";
import { isVoiceExtractionComplete } from "./extraction-schema";
import { determineNextState, type SessionState } from "./state-machine";
import { PHONE_SYSTEM_PROMPT, toSpokenReply, voiceNextSlotPrompt } from "./phone-agent";
import { nextTriageStep, captureEnrichmentAnswer } from "./triage";
import { buildModelMessages, MAX_HISTORY, type ChatTurn } from "./compaction";
import { logger } from "@/lib/logger";

/**
 * Spoken equivalent of CONFIRM_REPLY — no "tap a button" affordance. Does NOT
 * quote a time or arrival window (the team coordinates timing with the customer
 * later); it only confirms the request was captured and handed off.
 */
export const VOICE_CONFIRM_REPLY =
  "Great. I have everything I need. I'll get this over to our team and they'll follow up with you. Is there anything else I can help you with?";

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
    name: knownSlots.name ?? null,
    phone: knownSlots.phone ?? null,
    email: knownSlots.email ?? null,
    safetyScreenPassed: true,
    extras: { ...(knownSlots.extras ?? {}) },
  });
  const captured = captureEnrichmentAnswer(pendingStep?.id ?? null, userMessage);
  const capturedExtras = captured ? { [captured.key]: captured.value } : undefined;

  // At the address step the caller's whole reply IS the service address, but a
  // spoken address (Twilio transcription) lacks the comma/ZIP structure the
  // strict matcher anchors on — so it never fills and we re-ask forever. Use the
  // permissive at-step matcher there (the same fix the web chat uses). Outside
  // the address step we keep the strict matcher so a stray "123 Main" mid-issue
  // isn't misread as the service address.
  const atAddressStep =
    pendingStep?.id === "address" || pendingStep?.id === "address_parts";
  const resolvedAddress = atAddressStep
    ? extractAddressAtAddressStep(userMessage) ?? extracted.address
    : extracted.address;

  const hasContactSlot = Boolean(
    resolvedAddress || extracted.phone || extracted.email,
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
        address: resolvedAddress ?? undefined,
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
      address: resolvedAddress ?? undefined,
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
      extractionComplete = isVoiceExtractionComplete(extraction);
      metadataStr = JSON.stringify(extraction);
    }

    // Loop guard: when this turn merely filled a slot (an address/phone/email was
    // just captured) and intake isn't complete yet, advance to the NEXT missing
    // slot rather than re-speaking the router's canned line — re-speaking it is
    // what made the call repeat the same question. A genuine deterministic ANSWER
    // (e.g. business hours) is still spoken; completion still wins with the
    // confirmation. `verdict.reply` is preferred only when it's NOT a bare slot
    // provision.
    const baseReply = extractionComplete
      ? VOICE_CONFIRM_REPLY
      : isSlotProvision
        ? voiceNextSlotPrompt(merged)
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
