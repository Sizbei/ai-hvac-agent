import { NextRequest, after } from "next/server";
import { streamText } from "ai";
import { getModel } from "@/lib/ai/provider";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions, messages } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { isSameOriginRequest, hasJsonContentType } from "@/lib/session-csrf";
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
import { DEFAULT_MAX_TURNS } from "@/lib/ai/chat-limits";
import { isExtractionComplete } from "@/lib/ai/extraction-schema";
import { routeMessage, type KnownSlots } from "@/lib/ai/intent-router";
import {
  nextTriageStep,
  captureEnrichmentAnswer,
  type TriageSlots,
} from "@/lib/ai/triage";
import { EMPTY_ORG_CONFIG } from "@/lib/ai/router-config";
import { getRouterConfig } from "@/lib/admin/org-config-queries";
import { CONFIRM_REPLY } from "@/lib/ai/constants";
import { extractSlots, extractAddressLoose } from "@/lib/ai/slot-extract";
import { withLeadIn } from "@/lib/ai/lead-ins";
import { escalateSession } from "@/lib/ai/escalate-service";
import {
  parseKnownSlots,
  mergeSlots,
  hasSlotData,
  buildExtraction,
} from "@/lib/ai/chat-slots";
import { buildModelMessages, MAX_HISTORY, type ChatTurn } from "@/lib/ai/compaction";
import { compactSessionIfNeeded } from "@/lib/ai/compact-session";
import {
  lookupCustomerContext,
  buildCustomerContextHint,
  type CustomerContext,
} from "@/lib/ai/customer-context";
import { customers } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
// The deterministic router is on by default; set ROUTER_ENABLED=false to disable
// it (kill-switch) and route every turn through the LLM.
const ROUTER_ENABLED = process.env.ROUTER_ENABLED !== "false";

const ESCALATION_NOTE =
  "\n\nIf you'd prefer to speak with a human, you can tap “Talk to a Human” anytime.";

// Mirrors the confirm-route copy (DO_NOT_SERVICE) so a flagged customer gets the
// same refusal whether they reach the flag mid-chat or at confirm time.
const DO_NOT_SERVICE_REPLY =
  "We're unable to book this online. Please call our office so we can help you directly.";

/** Single-chunk text/plain response — byte-compatible with the SDK's text stream. */
function cannedTextResponse(text: string): Response {
  return new Response(text, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Deterministic next-question prompt, driven by the triage engine. Maps the
 * merged slots into the triage shape and asks for the single next question
 * (safety screen → qualifying questions → required fields → enrichment). When
 * the customer has answered/skipped everything, triage returns null and we fall
 * back to a gentle "anything else?" prompt. Quick-reply chips are appended in
 * parentheses so the deterministic (0-token) path still guides the customer.
 */
function nextSlotPrompt(merged: KnownSlots): string {
  const triageSlots: TriageSlots = {
    issueType: merged.issueType ?? null,
    urgency: merged.urgency ?? null,
    address: merged.address ?? null,
    name: merged.name ?? null,
    phone: merged.phone ?? null,
    // The router only reaches this prompt once the message is non-hazardous, so
    // treat the safety screen as cleared for the purpose of sequencing the
    // remaining intake (a real hazard is handled by the ESCALATE branch).
    safetyScreenPassed: true,
    extras: { ...(merged.extras ?? {}) },
  };
  const step = nextTriageStep(triageSlots);
  if (!step) {
    return "Thanks — is there anything else that would help the technician?";
  }
  const chips =
    step.quickReplies.length > 0
      ? ` (${step.quickReplies.map((r) => r.label).join(" · ")})`
      : "";
  return step.question + chips;
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

  // CSRF: the session cookie is SameSite=None, so a forged cross-site POST
  // would carry it. Only same-origin JSON requests (the legitimate chat client)
  // may push messages into the session — this blocks the text/plain form-POST
  // vector that could otherwise inject content / manipulate session metadata.
  if (!isSameOriginRequest(request)) {
    return errorResponse("Cross-origin request rejected", "FORBIDDEN_ORIGIN", 403);
  }
  if (!hasJsonContentType(request)) {
    return errorResponse("Expected application/json", "UNSUPPORTED_MEDIA_TYPE", 415);
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
      .where(eq(customerSessions.token, token))
      .limit(1);

    if (!session) {
      return errorResponse("Session not found", "SESSION_NOT_FOUND", 404);
    }

    // The org for every write in this turn comes from the session row, never a
    // hardcoded constant — a session created for tenant X always writes as X.
    const organizationId = session.organizationId;
    // Scope every session-row read/write by BOTH id and org (defense in depth,
    // matching escalate-service.ts) so a write can never touch another tenant.
    const sessionScope = and(
      eq(customerSessions.id, session.id),
      eq(customerSessions.organizationId, organizationId),
    );

    // The per-org turn limit was stamped onto the session at creation; fall back
    // to the system default for legacy rows created before the column existed.
    const maxTurns = session.maxTurns ?? DEFAULT_MAX_TURNS;

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

    // Do-Not-Service early gate: if a PRIOR turn already resolved this session to
    // a flagged customer (the FK persisted below), refuse before any router/LLM
    // work — the async extraction path can't alter an already-streamed reply, so
    // a customer first flagged mid-turn is enforced here on the NEXT turn. The
    // read is non-critical: a DB blip degrades to "no early gate" (the confirm
    // route is still the hard backstop), never a failed turn.
    if (session.customerId) {
      try {
        const [flagRow] = await db
          .select({ doNotService: customers.doNotService })
          .from(customers)
          .where(
            withTenant(
              customers,
              organizationId,
              eq(customers.id, session.customerId),
            ),
          )
          .limit(1);
        if (flagRow?.doNotService) {
          await db.insert(messages).values({
            organizationId,
            sessionId: session.id,
            role: "assistant",
            content: DO_NOT_SERVICE_REPLY,
            tokensUsed: 0,
          });
          logger.warn(
            { sessionId: session.id, customerId: session.customerId },
            "Chat blocked at load: customer flagged do_not_service",
          );
          return cannedTextResponse(DO_NOT_SERVICE_REPLY);
        }
      } catch (gateError: unknown) {
        logger.error(
          { error: gateError, sessionId: session.id },
          "Do-not-service load gate failed — continuing (confirm route still guards)",
        );
      }
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
          organizationId,
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
      organizationId,
      sessionId: session.id,
      role: "user",
      content: guardrailResult.sanitized,
    });

    const newTurnCount = session.turnCount + 1;
    const nearTurnLimit = newTurnCount >= maxTurns;

    // 7. Deterministic intent routing — answer/act on common messages with NO
    // LLM call. Falls back to the LLM for anything novel/ambiguous. The org's
    // config (disabled services, business-info personalization, custom FAQs) is
    // applied as an overlay — but it can never suppress an emergency.
    const knownSlots = parseKnownSlots(session.metadata);
    // The triage question we asked LAST turn = what triage would ask given the
    // slots as they stood BEFORE this message. Used to (a) loosely extract a
    // suffix-less address when we just asked for it, and (b) capture a bare
    // quick-reply enrichment answer deterministically.
    const pendingStep = nextTriageStep({
      issueType: knownSlots.issueType ?? null,
      urgency: knownSlots.urgency ?? null,
      address: knownSlots.address ?? null,
      name: knownSlots.name ?? null,
      phone: knownSlots.phone ?? null,
      safetyScreenPassed: true,
      extras: { ...(knownSlots.extras ?? {}) },
    });

    // Repeat-customer awareness: as soon as an email or phone is known (from a
    // prior turn's metadata OR a contact slot in THIS message), resolve any
    // existing customer — WITHOUT creating one — so we can (a) personalize the
    // reply, (b) enforce do-not-service early, and (c) skip re-asking the name.
    // A single indexed blind-index lookup; wrapped so a CRM blip degrades to
    // "no context" and never blocks the streamed reply. Only when the session
    // isn't already linked (the load gate above handles linked sessions).
    const turnSlots = extractSlots(guardrailResult.sanitized);
    const resolvedEmail = knownSlots.email ?? turnSlots.email ?? null;
    const resolvedPhone = knownSlots.phone ?? turnSlots.phone ?? null;
    let customerContext: CustomerContext | null = null;
    if (!session.customerId && (resolvedEmail || resolvedPhone)) {
      customerContext = await lookupCustomerContext(organizationId, {
        email: resolvedEmail,
        phone: resolvedPhone,
      }).catch((lookupError: unknown) => {
        logger.error(
          { error: lookupError, sessionId: session.id },
          "Customer-context lookup failed — continuing without context",
        );
        return null;
      });

      if (customerContext) {
        // Persist the canonical link onto the session FK so the next turn's load
        // gate can enforce do-not-service before any work. Non-critical write.
        await db
          .update(customerSessions)
          .set({ customerId: customerContext.customerId, updatedAt: new Date() })
          .where(sessionScope)
          .catch((linkError: unknown) => {
            logger.error(
              { error: linkError, sessionId: session.id },
              "Failed to link session to customer — continuing",
            );
          });

        // Do-not-service: refuse immediately rather than continuing intake.
        if (customerContext.doNotService) {
          await db.insert(messages).values({
            organizationId,
            sessionId: session.id,
            role: "assistant",
            content: DO_NOT_SERVICE_REPLY,
            tokensUsed: 0,
          });
          await db
            .update(customerSessions)
            .set({ turnCount: newTurnCount, updatedAt: new Date() })
            .where(sessionScope);
          logger.warn(
            {
              sessionId: session.id,
              customerId: customerContext.customerId,
            },
            "Chat blocked mid-turn: customer flagged do_not_service",
          );
          return cannedTextResponse(DO_NOT_SERVICE_REPLY);
        }
      }
    }

    // If we already know a returning customer's full name (PII, server-side
    // only), pre-seed the name slot so triage/the next-slot prompt never re-ask
    // for it. Only when we don't already have a name from this conversation.
    const seededName =
      !knownSlots.name && customerContext?.fullName
        ? customerContext.fullName
        : undefined;

    if (ROUTER_ENABLED) {
      // The org overlay is non-critical: if its read fails (DB blip, cold
      // start), degrade to the empty overlay (everything enabled, no
      // personalization) rather than failing the customer's whole turn.
      const routerConfig = await getRouterConfig(organizationId).catch(
        (configError: unknown) => {
          logger.error(
            { error: configError, sessionId: session.id },
            "Failed to load router config — using empty overlay",
          );
          return EMPTY_ORG_CONFIG;
        },
      );
      const verdict = routeMessage(
        guardrailResult.sanitized,
        knownSlots,
        routerConfig,
      );
      const extracted = extractSlots(guardrailResult.sanitized);
      // When we JUST asked for the address, accept a suffix-less answer
      // ("123 Main") that the strict extractor would miss — fixes the re-ask
      // bug where such a reply fell through to the LLM and got re-asked.
      const addressAnswer =
        pendingStep?.id === "address" && !extracted.address
          ? extractAddressLoose(guardrailResult.sanitized)
          : extracted.address;

      // A "slot provision" turn: the customer supplied an address/phone/email.
      // There's no intent for a bare address, so the router returns FALLBACK —
      // but we can still fill the slot deterministically instead of paying for
      // an LLM call (which, mid-intake, often re-asks for info already on
      // screen). We treat it as slot provision when the issue is already known
      // OR there's prior conversation (the customer is answering a question).
      //
      // Why not require knownSlots.issueType? Classification of novel issues
      // (e.g. "heat pump short cycling") comes from the *async* background
      // extraction, which can lag 10s+. Gating on it meant a fast follow-up
      // address fell through to the LLM and got re-asked, and the intake
      // stepper never lit up. extractSlots is conservative (number+street+
      // suffix, 10-digit phone, real email), so false positives are unlikely;
      // issueType/urgency it can't infer are still filled by the background
      // extraction on the LLM turns.
      const hasContactSlot = Boolean(
        addressAnswer || extracted.phone || extracted.email,
      );
      const isSlotProvision =
        hasContactSlot &&
        (Boolean(knownSlots.issueType) || conversationHistory.length > 0);

      if (verdict.action !== "FALLBACK_LLM" || isSlotProvision) {
        if (verdict.escalate) {
          // Bug fix: on an emergency escalation we MUST have a way to reach the
          // customer and a place to send help. If the address or phone isn't
          // already known and wasn't in this message, append an explicit ask so
          // the reply itself captures it — rather than leaving the dispatcher
          // with a blank-location emergency. (The session escalates either way;
          // any reply the customer sends next is still recorded on the session.)
          const escAddress = addressAnswer ?? knownSlots.address ?? null;
          const escPhone = extracted.phone ?? knownSlots.phone ?? null;
          const missingAsk =
            !escAddress && !escPhone
              ? " So we can get help to you fast, what's the address, and a phone number to reach you?"
              : !escAddress
                ? " So we can dispatch help, what's the service address?"
                : !escPhone
                  ? " What's the best phone number to reach you right now?"
                  : "";
          const replyText =
            (verdict.reply ?? "") +
            missingAsk +
            (nearTurnLimit ? ESCALATION_NOTE : "");
          await db.insert(messages).values({
            organizationId,
            sessionId: session.id,
            role: "assistant",
            content: replyText,
            tokensUsed: 0,
          });
          const escResult = await escalateSession({
            organizationId,
            sessionId: session.id,
            currentStatus: session.status,
            ipAddress: ip,
          });
          if (!escResult.ok) {
            // "already_transitioned" is a benign concurrency race (another turn
            // escalated first) — warn, don't error. Anything else is a real
            // failure to record a safety-critical escalation.
            const logCtx = {
              sessionId: session.id,
              reason: escResult.reason,
            };
            const msg = "Deterministic escalation did not apply";
            if (escResult.reason === "already_transitioned") {
              logger.warn(logCtx, msg);
            } else {
              logger.error(logCtx, msg);
            }
          }
          // Persist whatever we already know (the emergency's issueType/urgency
          // hint + any regex-extracted contact slots) into metadata. The
          // background LLM extraction never runs on this path (we return
          // below), so without this the admin would see a BLANK emergency
          // request — the worst case to have no details on.
          const escMerged = mergeSlots(knownSlots, {
            issueType: verdict.issueType ?? undefined,
            urgency: verdict.urgency ?? undefined,
            address: addressAnswer ?? undefined,
            phone: extracted.phone ?? undefined,
            email: extracted.email ?? undefined,
          });
          const escMetadata = hasSlotData(escMerged)
            ? JSON.stringify(
                buildExtraction(
                  escMerged,
                  (conversationHistory.find((m) => m.role === "user")
                    ?.content ?? guardrailResult.sanitized).slice(0, 280),
                ),
              )
            : session.metadata;
          await db
            .update(customerSessions)
            .set({
              metadata: escMetadata,
              turnCount: newTurnCount,
              updatedAt: new Date(),
            })
            .where(sessionScope);

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

        // If the customer's message is a bare quick-reply answer to the
        // enrichment question we asked last turn (pendingStep, computed above),
        // capture it deterministically (0-token) into the extras bag.
        const captured = captureEnrichmentAnswer(
          pendingStep?.id ?? null,
          guardrailResult.sanitized,
        );
        const capturedExtras = captured
          ? { [captured.key]: captured.value }
          : undefined;

        // Merge router + regex-extracted slots into the session metadata. A
        // returning customer's stored name (seededName) fills the name slot so
        // intake skips the name question — mergeSlots never clobbers a name the
        // customer already provided this conversation.
        const merged = mergeSlots(knownSlots, {
          issueType: verdict.issueType ?? undefined,
          urgency: verdict.urgency ?? undefined,
          address: addressAnswer ?? undefined,
          phone: extracted.phone ?? undefined,
          email: extracted.email ?? undefined,
          name: seededName,
          extras: capturedExtras,
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
        const nextQuestion = extractionComplete
          ? CONFIRM_REPLY
          : verdict.action !== "FALLBACK_LLM" && verdict.reply
            ? verdict.reply
            : nextSlotPrompt(merged);

        // Conversational warmth (Stage 3b): when we're still collecting info on a
        // NON-emergency turn, prepend a brief, varied acknowledgement of the
        // stated issue before the next question — template-based and 0-token, so
        // the critical path stays LLM-free. We skip it once intake is complete
        // (the confirm copy reads better on its own) and ALWAYS skip it for
        // emergencies (withLeadIn returns "" for emergency urgency, so the exact
        // safety copy is never softened). The merged urgency reflects this turn's
        // router verdict + prior slots. newTurnCount rotates the variant.
        const baseReply = extractionComplete
          ? nextQuestion
          : withLeadIn(
              nextQuestion,
              merged.issueType,
              merged.urgency,
              newTurnCount,
            );
        const replyText = baseReply + (nearTurnLimit ? ESCALATION_NOTE : "");

        await db.insert(messages).values({
          organizationId,
          sessionId: session.id,
          role: "assistant",
          content: replyText,
          tokensUsed: 0,
        });

        const nextState = determineNextState(
          session.status,
          extractionComplete,
          newTurnCount,
          maxTurns,
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

    // Returning-customer note (non-PII: first name + counts/membership) so the
    // model greets them by name, acknowledges prior service, and skips re-asking
    // info already on file. Empty string when not a returning customer.
    const customerContextHint = buildCustomerContextHint(customerContext);

    // 8. Stream response via Vercel AI SDK per SC-09
    const result = streamText({
      model: getModel(),
      system: SYSTEM_PROMPT + customerContextHint + escalationHint,
      // Cap output so replies stay short (the prompt asks for 2-3 sentences) and
      // tail costs are bounded (Token-Savings #6).
      maxOutputTokens: 350,
      // Sliding window + rolling summary: the model sees a "summary of earlier
      // conversation" (turns that aged out of the window) plus the most recent
      // turns and the current message. This bounds the quadratic token growth
      // of full-history re-sends (Token-Savings #4) while keeping long
      // conversations coherent past MAX_HISTORY turns.
      messages: buildModelMessages({
        runningSummary: session.runningSummary,
        recent: conversationHistory.slice(-MAX_HISTORY) as ChatTurn[],
        current: guardrailResult.sanitized,
      }).map((m) => ({ role: m.role, content: m.content })),
      onFinish: async ({ text, usage }) => {
        const tokensThisCall =
          (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);

        // Save assistant message
        await db.insert(messages).values({
          organizationId,
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
          .where(sessionScope);

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

    // Run extraction after the response is sent. We use next/server's `after()`
    // (not a detached promise) because on serverless the function is frozen once
    // the streamed response closes — a bare `.then()` would be killed mid-flight,
    // so issueType/urgency never persisted in production and the intake stepper
    // stayed blank. `after()` registers the work with the platform's waitUntil so
    // it runs to completion. Extraction needs only the conversation + the user
    // message (not the assistant reply), so it can run independently of onFinish.
    after(async () => {
      try {
        const extraction = await extractServiceRequest(
          conversationHistory,
          guardrailResult.sanitized,
        );
        // Re-read CURRENT metadata (not the request-time snapshot): a rapid
        // follow-up turn may have written new slots while extraction ran.
        // Merging against the snapshot would silently drop them.
        const [fresh] = await db
          .select({
            metadata: customerSessions.metadata,
            status: customerSessions.status,
          })
          .from(customerSessions)
          .where(sessionScope);
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
        // Compute the next state from the session's CURRENT status (re-read
        // above), not the request-time snapshot — a faster follow-up turn or an
        // escalation may have advanced it. determineNextState won't move a
        // terminal/escalated/submitted session, so a late extraction can't
        // regress it. Fall back to the snapshot only if the re-read missed.
        const currentStatus = fresh?.status ?? session.status;
        const nextState = determineNextState(
          currentStatus,
          extractionComplete,
          newTurnCount,
          maxTurns,
        );

        await db
          .update(customerSessions)
          .set({
            status: nextState,
            // Always write the merged extraction (the merge never nulls a
            // filled slot); only fall back to the FRESH metadata, not the stale
            // request-time snapshot, when there's nothing to write.
            metadata: hasSlotData(merged)
              ? JSON.stringify(mergedExtraction)
              : (fresh?.metadata ?? session.metadata),
            updatedAt: new Date(),
          })
          .where(sessionScope);

        // Repeat-customer link from the ASYNC path: the background extraction
        // may surface an email/phone the synchronous slot extractor missed (e.g.
        // a name+email written out in prose). If we resolve a customer and the
        // session isn't linked yet, persist the FK so the NEXT turn's load gate
        // can greet them / enforce do-not-service. We can't alter the reply that
        // already streamed this turn, so enforcement is deferred to that gate.
        if (!session.customerId && (merged.email || merged.phone)) {
          const asyncContext = await lookupCustomerContext(organizationId, {
            email: merged.email,
            phone: merged.phone,
          }).catch(() => null);
          if (asyncContext) {
            await db
              .update(customerSessions)
              .set({
                customerId: asyncContext.customerId,
                updatedAt: new Date(),
              })
              .where(sessionScope)
              .catch(() => {});
          }
        }

        logger.info(
          { sessionId: session.id, extractionComplete },
          "Background extraction complete",
        );
      } catch (extractionError: unknown) {
        logger.error(
          { error: extractionError, sessionId: session.id },
          "Background extraction failed",
        );
        // Ensure session state stays consistent even if extraction fails
        const fallbackState = determineNextState(
          session.status,
          false,
          newTurnCount,
          maxTurns,
        );
        await db
          .update(customerSessions)
          .set({ status: fallbackState, updatedAt: new Date() })
          .where(sessionScope)
          .catch(() => {});
      }
    });

    // Compaction runs in its own background task, independent of extraction so
    // a failure in one never affects the other. The conversation as of this
    // turn is the prior history + the user message we just saved (the assistant
    // reply is the newest turn and stays inside the window, so it doesn't need
    // to be included for the overflow calculation).
    after(async () => {
      try {
        const turnsThisTurn: ChatTurn[] = [
          ...conversationHistory,
          { role: "user", content: guardrailResult.sanitized },
        ];
        const compacted = await compactSessionIfNeeded({
          sessionId: session.id,
          organizationId,
          history: turnsThisTurn,
        });
        if (compacted) {
          logger.info(
            { sessionId: session.id },
            "Conversation compacted into running summary",
          );
        }
      } catch (compactionError: unknown) {
        // Non-fatal: the conversation simply continues uncompacted.
        logger.error(
          { error: compactionError, sessionId: session.id },
          "Conversation compaction failed",
        );
      }
    });

    return result.toTextStreamResponse();
  } catch (error) {
    logger.error({ error }, "Chat endpoint error");
    return errorResponse("Chat processing failed", "CHAT_FAILED", 500);
  }
}
