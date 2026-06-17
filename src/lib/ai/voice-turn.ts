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
import { extractAddressAtAddressStep } from "./slot-extract";
import { extractAllContactFields } from "./extract-all-contact";
import { extractSpokenPhone } from "./extract-spoken-phone";
import {
  detectCorrection,
  correctionFieldLabel,
  type DetectedCorrection,
} from "./detect-correction";
import { isBusinessName } from "./detect-business-name";
import { withLeadIn } from "./lead-ins";
import { getRouterConfig } from "@/lib/admin/org-config-queries";
import { EMPTY_ORG_CONFIG } from "./router-config";
import { escalateSession } from "./escalate-service";
import {
  parseKnownSlots,
  mergeSlots,
  hasSlotData,
  buildExtraction,
  stripSkipSentinels,
  SKIP_SENTINEL,
} from "./chat-slots";
import {
  isVoiceExtractionComplete,
  isAddressComplete,
  serviceRequestSchema,
  type IssueType,
} from "./extraction-schema";
import { submitSessionServiceRequest } from "@/lib/requests/submit-session-request";
import { determineNextState, type SessionState } from "./state-machine";
import { PHONE_SYSTEM_PROMPT, toSpokenReply, voiceNextSlotPrompt } from "./phone-agent";
import { nextTriageStep, captureEnrichmentAnswer } from "./triage";
import { buildModelMessages, MAX_HISTORY, type ChatTurn } from "./compaction";
import type { Urgency } from "./router-types";
import { logger } from "@/lib/logger";

/**
 * The optional enrichment steps voice actually asks (see VOICE_STEP_PHRASING),
 * mapped to their extras key. On a call, an unrecognized reply to one of these
 * must latch as skipped (write the SKIP_SENTINEL into the extra) so the stepper
 * advances instead of re-asking — a phone call gets one shot per optional
 * question. The required steps (system_down, duration) are intentionally absent:
 * they are not skippable. Kept local so triage's internal map stays private.
 */
const VOICE_OPTIONAL_STEP_EXTRA: Record<string, string> = {
  system_type: "systemType",
  preferred_window: "preferredWindow",
};

/**
 * Prepend a single brief spoken acknowledgement to the next question, matching
 * the web chat's warmth without stacking. Priority (one ack only): an explicit
 * correction the caller just made, then a commercial-account note when the
 * captured name is a business, then the issue/urgency lead-in (which the shared
 * helper already limits to a single early turn). On an emergency or when nothing
 * applies, the question is returned unchanged — voice stays terse under
 * pressure.
 */
function acknowledge(
  nextQuestion: string,
  ctx: {
    readonly correction: DetectedCorrection | null;
    readonly name: string | null;
    readonly issueType: IssueType | null;
    readonly urgency: Urgency | null;
    readonly turn: number;
  },
): string {
  if (ctx.urgency === "emergency") return nextQuestion;

  if (ctx.correction) {
    const label = correctionFieldLabel(ctx.correction.field);
    return `Got it, I've updated your ${label}. ${nextQuestion}`;
  }

  if (ctx.name && isBusinessName(ctx.name)) {
    return `Thanks, I'll note this as a commercial account for ${ctx.name}. ${nextQuestion}`;
  }

  return withLeadIn(nextQuestion, ctx.issueType, ctx.urgency, ctx.turn);
}

/**
 * Spoken equivalent of CONFIRM_REPLY — no "tap a button" affordance. Does NOT
 * quote a time or arrival window (the team coordinates timing with the customer
 * later); it only confirms the request was captured and handed off.
 */
export const VOICE_CONFIRM_REPLY =
  "Great. I have everything I need. I'll get this over to our team and they'll follow up with you. Is there anything else I can help you with?";

/**
 * Spoken on the turn the completed intake is AUTO-SUBMITTED (voice has no
 * Confirm & Submit button — the moment intake completes, the request is
 * created, so this promise is true even if the caller hangs up right after).
 */
export const VOICE_SUBMITTED_REPLY =
  "Great — I have everything I need. I've sent your request over to our team and they'll follow up with you shortly. Is there anything else I can help you with?";

/** Spoken when the do-not-service guard blocks an automated booking. */
const VOICE_OFFICE_REPLY =
  "I'm not able to book this automatically. Please give our office a call and we'll help you directly. Thanks for calling.";

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
  const routed = routeMessage(userMessage, knownSlots, routerConfig);
  // Account-data intents (membership/visit/balance/appointment/reschedule) are a
  // WEB-CHAT v1 capability. The voice channel has no identity gate wired for them
  // yet, so coerce an ACCOUNT_LOOKUP verdict to a plain LLM fallback here — voice
  // behavior is byte-identical to before this feature (these questions fall to
  // the LLM, never reading account data on a phone call).
  const verdict =
    routed.action === "ACCOUNT_LOOKUP"
      ? { ...routed, action: "FALLBACK_LLM" as const, reply: null }
      : routed;
  // Multi-field capture, matching the web chat: one utterance can carry the
  // address, phone, email, AND a residual name ("Ray Chen, 865-555-1212"). The
  // narrower extractSlots used before never captured a spoken name, so triage
  // couldn't latch completion and the call stalled at confirm.
  const allContact = extractAllContactFields(userMessage, {
    allowResidualName: true,
  });

  // The step we asked LAST turn — used to scope the at-step address/phone
  // fallbacks and the optional-enrichment skip latch.
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

  // At the address step the caller's whole reply IS the service address, but a
  // spoken address (Twilio transcription) lacks the comma/ZIP structure the
  // strict matcher anchors on — so it never fills and we re-ask forever. Use the
  // permissive at-step matcher there (the same fix the web chat uses). Outside
  // the address step we keep the strict matcher so a stray "123 Main" mid-issue
  // isn't misread as the service address.
  const atAddressStep =
    pendingStep?.id === "address" || pendingStep?.id === "address_parts";
  // The LLM (not the stepper) may have been the one to ask for the address —
  // on those turns pendingStep points elsewhere and the strict extractor
  // truncates a spoken "212 East Unaka Avenue, Johnson City, Tennessee 37601"
  // at the first comma, storing an address that can never validate (the root
  // of the voice address re-ask loop). So whenever the address slot is still
  // missing and the utterance parses as a COMPLETE address, trust the at-step
  // extractor's verbatim capture.
  const spokenFullAddress =
    !atAddressStep && !knownSlots.address
      ? extractAddressAtAddressStep(userMessage)
      : null;
  const resolvedAddress = atAddressStep
    ? extractAddressAtAddressStep(userMessage) ?? allContact.address
    : spokenFullAddress && isAddressComplete(spokenFullAddress)
      ? spokenFullAddress
      : allContact.address;

  // City/ZIP follow-up (address_parts): the reply is normally the missing TAIL
  // of an address we already hold — append it (web parity) so the engine sees a
  // complete address instead of looping. A reply that starts with a street
  // number is a re-given full address and replaces the base.
  const partsTail =
    pendingStep?.id === "address_parts" &&
    knownSlots.address &&
    resolvedAddress &&
    !/^\s*\d/.test(userMessage.trim()) &&
    // A reply that parsed as a phone/email answers a different field — don't
    // glue it onto the address.
    !allContact.phone &&
    !allContact.email
      ? `${knownSlots.address.trim()}, ${userMessage.trim()}`.slice(0, 500)
      : null;

  // At the phone step, a caller often reads the number digit-by-digit, which
  // Twilio may transcribe as a loose run of single digits the grouped regex
  // misses. Fall back to the spoken-phone digit extractor there only, so a
  // missed number doesn't loop. Elsewhere the strict regex result stands.
  const resolvedPhone =
    pendingStep?.id === "phone"
      ? allContact.phone ?? extractSpokenPhone(userMessage)
      : allContact.phone;

  // A mid-call correction to an already-filled field ("actually my number is
  // 865-555-1212"). Generic logic, ported from the web chat — there's no reason
  // to ignore corrections on a phone call. Skipped at the address step, where
  // the whole reply is already treated as the (new) address above.
  //
  // IMPORTANT: voiceNextSlotPrompt SKIPS the name and email steps, but the raw
  // nextTriageStep still reports `name`/`email` as pending whenever those slots
  // are empty. detectCorrection treats `pendingStepId === "name"` as a DIRECT
  // name answer (the whole utterance is the name) — but on a call we never
  // actually asked for the name, so the caller's reply is really answering the
  // enrichment question voice DID ask (e.g. "boiler" for system type). Passing
  // "name" here would silently store "boiler" as the caller's name. Voice only
  // ever asks the voice-askable steps, so we never pass name/email as the
  // pending step; corrections still fire via their explicit cue ("actually…").
  const correctionStepId =
    pendingStep && pendingStep.id !== "name" && pendingStep.id !== "email"
      ? pendingStep.id
      : null;
  const correction = atAddressStep
    ? null
    : detectCorrection(userMessage, correctionStepId);

  // Capture a bare enrichment answer (the spoken-back chip value) into extras,
  // mirroring the web chat — so phone enrichment answers actually persist
  // instead of being spoken into the void.
  const captured = captureEnrichmentAnswer(pendingStep?.id ?? null, userMessage);
  // Skip latch: when the pending step is an OPTIONAL enrichment step voice asked
  // (system_type / preferred_window) and the reply wasn't recognized as a value,
  // mark it skipped so the stepper advances. A phone call gets one shot per
  // optional question — otherwise an unrecognized answer re-asks it forever.
  const optionalExtraKey = pendingStep
    ? VOICE_OPTIONAL_STEP_EXTRA[pendingStep.id]
    : undefined;
  const shouldSkipOptional =
    !captured && optionalExtraKey !== undefined;
  // Address re-prompt counter (web parity): without it MAX_ADDRESS_REPROMPTS
  // never engages on a call and the city/ZIP follow-up can re-ask forever.
  const addressControl: Record<string, unknown> =
    pendingStep?.id === "address_parts"
      ? {
          addressAttempts: Number(knownSlots.extras?.addressAttempts ?? 0) + 1,
        }
      : {};
  const capturedExtrasBase = captured
    ? { [captured.key]: captured.value }
    : shouldSkipOptional
      ? { [optionalExtraKey as string]: SKIP_SENTINEL }
      : undefined;
  const capturedExtras =
    capturedExtrasBase || Object.keys(addressControl).length > 0
      ? { ...(capturedExtrasBase ?? {}), ...addressControl }
      : undefined;

  const hasContactSlot = Boolean(
    resolvedAddress || resolvedPhone || allContact.email || correction,
  );
  const isSlotProvision =
    hasContactSlot && (Boolean(knownSlots.issueType) || history.length > 0);

  // A bare answer to the enrichment question we asked LAST turn (captured value
  // or a skip-latched optional step) must stay on the deterministic path — same
  // as the web chat. Otherwise it falls to the LLM and the captured/skipped
  // value is never persisted, so the stepper re-asks the same question forever.
  const pendingAnswerCaptured = capturedExtras !== undefined;

  // The contact-field updates to merge this turn: the extracted values, with a
  // detected correction overriding the matching field (a correction is the
  // caller explicitly fixing a value, so it must win). Used identically by both
  // the escalation merge and the deterministic merge so the two paths can't
  // drift. mergeSlots only overwrites with filled values, so `undefined` here
  // never clobbers a previously-captured slot.
  const slotUpdates: {
    address?: string;
    phone?: string;
    email?: string;
    name?: string;
  } = {
    address:
      (correction?.field === "address"
        ? correction.value
        : partsTail ?? resolvedAddress) ?? undefined,
    phone:
      (correction?.field === "phone" ? correction.value : resolvedPhone) ??
      undefined,
    email:
      (correction?.field === "email" ? correction.value : allContact.email) ??
      undefined,
    name:
      (correction?.field === "name" ? correction.value : allContact.name) ??
      undefined,
  };

  // ── Emergency / escalation ──
  if (verdict.action !== "FALLBACK_LLM" || isSlotProvision || pendingAnswerCaptured) {
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
        ...slotUpdates,
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
      ...slotUpdates,
      extras: capturedExtras,
    });

    let metadataStr = session.metadata;
    let extractionComplete = false;
    let extraction: ReturnType<typeof buildExtraction> | null = null;
    if (hasSlotData(merged)) {
      const firstUser =
        history.find((m) => m.role === "user")?.content ?? userMessage;
      extraction = buildExtraction(merged, firstUser.slice(0, 280));
      extractionComplete = isVoiceExtractionComplete(extraction);
      metadataStr = JSON.stringify(extraction);
    }

    // ── Auto-submit (voice has no Confirm & Submit button) ──
    // The moment the spoken intake completes, create the service request
    // through the same shared write path as the web confirm. Submitting BEFORE
    // we speak means "I've sent your request to our team" is true even if the
    // caller hangs up immediately after. On any failure we fall through to the
    // old confirm copy — the conversation (with full metadata) still exists
    // for the team. Re-entry is impossible: the batch flips the session to
    // "submitted", which the gather route terminates before reaching us.
    if (extractionComplete && extraction) {
      const requestPayload = {
        issueType: merged.issueType,
        urgency: merged.urgency,
        address: merged.address,
        customerName: merged.name ?? null,
        customerPhone: merged.phone ?? null,
        customerEmail:
          !merged.email || merged.email === SKIP_SENTINEL ? null : merged.email,
        description: extraction.description,
        // Enrichment extras ride at the top level of the request payload, with
        // skip sentinels stripped (the schema drops unknown control keys).
        ...stripSkipSentinels(merged.extras ?? {}),
      };
      const parsedRequest = serviceRequestSchema.safeParse(requestPayload);
      if (parsedRequest.success) {
        try {
          const submitted = await submitSessionServiceRequest({
            organizationId,
            sessionId: session.id,
            data: parsedRequest.data,
            ipAddress,
          });
          if (submitted.ok) {
            const reply = toSpokenReply(VOICE_SUBMITTED_REPLY, { nearLimit });
            await db.insert(messages).values({
              organizationId,
              sessionId: session.id,
              role: "assistant",
              content: reply,
              tokensUsed: 0,
            });
            // Status is already "submitted" via the submission batch — only
            // metadata/turn bookkeeping remains for this turn.
            await db
              .update(customerSessions)
              .set({
                metadata: metadataStr,
                turnCount: newTurnCount,
                updatedAt: new Date(),
              })
              .where(sessionScope);
            return { reply, endCall: false, nextState: "submitted" };
          }
          if (submitted.reason === "do_not_service") {
            const reply = toSpokenReply(VOICE_OFFICE_REPLY, {});
            await db.insert(messages).values({
              organizationId,
              sessionId: session.id,
              role: "assistant",
              content: reply,
              tokensUsed: 0,
            });
            await db
              .update(customerSessions)
              .set({
                metadata: metadataStr,
                turnCount: newTurnCount,
                updatedAt: new Date(),
              })
              .where(sessionScope);
            return { reply, endCall: true, nextState: session.status };
          }
          // insert_failed → fall through to the confirm copy below.
        } catch (submitError: unknown) {
          logger.error(
            { error: submitError, sessionId: session.id },
            "Voice auto-submit failed — falling back to confirm copy",
          );
        }
      } else {
        logger.warn(
          { sessionId: session.id, issues: parsedRequest.error.issues },
          "Voice extraction complete but request payload failed validation",
        );
      }
    }

    // Loop guard: when this turn merely filled a slot (an address/phone/email was
    // just captured) and intake isn't complete yet, advance to the NEXT missing
    // slot rather than re-speaking the router's canned line — re-speaking it is
    // what made the call repeat the same question. A genuine deterministic ANSWER
    // (e.g. business hours) is still spoken; completion still wins with the
    // confirmation. `verdict.reply` is preferred only when it's NOT a bare slot
    // provision.
    const nextQuestion = voiceNextSlotPrompt(merged);
    // SUBMIT is included: the router's required-slot view (issue/urgency/
    // address) is narrower than the voice gate (phone), so its canned confirm
    // copy — which says "tap Confirm & Submit", a screen affordance — must
    // never be spoken. The voice completeness gate owns confirmation.
    const isAdvancing =
      !extractionComplete &&
      (isSlotProvision ||
        verdict.action === "FALLBACK_LLM" ||
        verdict.action === "SUBMIT" ||
        !verdict.reply);
    const baseReply = extractionComplete
      ? VOICE_CONFIRM_REPLY
      : isAdvancing
        ? acknowledge(nextQuestion, {
            correction,
            name: slotUpdates.name ?? null,
            issueType: merged.issueType as IssueType | null,
            urgency: merged.urgency as Urgency | null,
            turn: newTurnCount,
          })
        : verdict.reply ?? nextQuestion;
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

  // Tell the model what intake state already exists. LLM turns persist no
  // extraction, so without this the model has no idea which slots are filled
  // and freelances repeat asks and endless re-confirmation loops.
  const knownFacts = [
    knownSlots.issueType ? `issue: ${knownSlots.issueType}` : null,
    knownSlots.urgency ? `urgency: ${knownSlots.urgency}` : null,
    knownSlots.address ? `service address: ${knownSlots.address}` : null,
    knownSlots.phone ? `callback phone: ${knownSlots.phone}` : null,
    knownSlots.name ? `name: ${knownSlots.name}` : null,
  ].filter(Boolean);
  const slotContextHint =
    knownFacts.length > 0
      ? `\n\nALREADY CAPTURED AND SAVED (never re-ask or re-confirm these): ${knownFacts.join("; ")}.`
      : "";

  const { text, usage } = await generateText({
    model: await getModel(organizationId),
    system: PHONE_SYSTEM_PROMPT + slotContextHint,
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
