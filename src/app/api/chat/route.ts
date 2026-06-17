import { NextRequest, after } from "next/server";
import { streamText } from "ai";
import { getModel } from "@/lib/ai/provider";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  customerSessions,
  messages,
  organizationSettings,
  attachments,
} from "@/lib/db/schema";
import {
  resolveAfterHoursConfig,
  type AfterHoursConfig,
} from "@/lib/admin/after-hours";
import {
  decideAfterHoursDisclosure,
  type BookingTarget,
  type CustomerUrgencySignal,
} from "@/lib/ai/after-hours-chat";
import { withTenant } from "@/lib/db/tenant";
import { errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { isSameOriginRequest, hasJsonContentType } from "@/lib/session-csrf";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { buildSystemPrompt, brandInfoFromConfig } from "@/lib/ai/system-prompt";
import { sanitizeInput, GUARDRAIL_SOFT_REPLY } from "@/lib/ai/guardrails";
import {
  extractServiceRequest,
  type Message as AIMessage,
} from "@/lib/ai/extract";
import {
  determineNextState,
  isTerminalState,
  type SessionState,
} from "@/lib/ai/state-machine";
import { checkTokenBudget, addTokenUsage } from "@/lib/ai/token-budget";
import { DEFAULT_MAX_TURNS } from "@/lib/ai/chat-limits";
import { isExtractionComplete } from "@/lib/ai/extraction-schema";
import { routeMessage, type KnownSlots } from "@/lib/ai/intent-router";
import {
  nextTriageStep,
  captureEnrichmentAnswer,
  isSkip,
  MAX_EMAIL_REPROMPTS,
  type TriageSlots,
} from "@/lib/ai/triage";
import { EMPTY_ORG_CONFIG } from "@/lib/ai/router-config";
import { getRouterConfig } from "@/lib/admin/org-config-queries";
import {
  getOpenAvailability,
  businessDaysFrom,
  businessTodayIso,
} from "@/lib/admin/availability-queries";
import {
  buildWindowPrompt,
  type WindowChip,
} from "@/lib/ai/availability-prompt";
import { CONFIRM_REPLY, HANDOFF_REPLY } from "@/lib/ai/constants";
import {
  extractSlots,
  extractAddressAtAddressStep,
} from "@/lib/ai/slot-extract";
import { extractAllContactFields } from "@/lib/ai/extract-all-contact";
import { detectCorrection, correctionFieldLabel } from "@/lib/ai/detect-correction";
import { isBusinessName } from "@/lib/ai/detect-business-name";
import { withLeadIn, leadInForIssue } from "@/lib/ai/lead-ins";
import {
  sessionSeed,
  buildStyleHint,
  updateReAskState,
  reAskBreakPrompt,
  updateFrustration,
  FRUSTRATION_HUMAN_OFFER,
} from "@/lib/ai/conversation-style";
import { escalateSession } from "@/lib/ai/escalate-service";
import {
  parseKnownSlots,
  mergeSlots,
  hasSlotData,
  buildExtraction,
  SKIP_SENTINEL,
} from "@/lib/ai/chat-slots";
import { buildModelMessages, MAX_HISTORY, type ChatTurn } from "@/lib/ai/compaction";
import { compactSessionIfNeeded } from "@/lib/ai/compact-session";
import {
  lookupCustomerContext,
  buildCustomerContextHint,
  enrichWithServiceHistory,
  type CustomerContext,
} from "@/lib/ai/customer-context";
import { customers } from "@/lib/db/schema";
import {
  getMembershipSummary,
  getNextVisit,
  getOpenBalance,
  getUpcomingAppointment,
  requestReschedule,
} from "@/lib/ai/account-tools";
import {
  membershipReply,
  nextVisitReply,
  balanceReply,
  appointmentReply,
  rescheduleReply,
} from "@/lib/ai/account-reply";
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

// Behavioral instruction appended to the LLM system prompt (as a separate block,
// NOT a rewrite of the brand persona) when the request is currently after-hours.
// Tells the model the urgent/not-urgent branch + the strict NO-dollar-amount
// disclosure rule. Emergencies still take the brand persona's safety path first.
const AFTER_HOURS_LLM_INSTRUCTION = `

AFTER-HOURS (it is currently outside our normal business hours): Before fully committing to dispatch, find out whether the situation is urgent — UNLESS it's already clearly an emergency or high-urgency (then skip the question and treat it as urgent). If it IS urgent (or the customer confirms yes): continue the intake AND let them know that, since it's after our normal hours, an additional after-hours service charge applies and our team will confirm the details. NEVER state a dollar amount or quote a price — just that a charge applies. If it is NOT urgent: offer to set them up for our next business day at no after-hours charge, and continue accordingly. SAFETY ALWAYS WINS: if there's any hazard (gas/CO/electrical/flooding), follow the safety instructions above and connect them to a person immediately — never delay a hazard to discuss charges.`;

/**
 * Interpret a customer's reply to the after-hours "is this urgent?" ask as a
 * yes/no signal. Only meaningful when we ASKED last turn (pendingStep is the
 * urgency step); otherwise we return "unknown" and let urgency classification
 * drive the decision. Conservative: only clear affirmatives/negatives flip it.
 */
function readUrgencySignal(
  askedUrgencyLastTurn: boolean,
  message: string,
): CustomerUrgencySignal {
  if (!askedUrgencyLastTurn) return "unknown";
  const m = message.trim().toLowerCase();
  if (
    /\b(urgent|emergency|asap|right now|today|tonight|now|yes|yeah|yep|please do)\b/.test(
      m,
    ) ||
    /can'?t wait/.test(m)
  ) {
    return "urgent";
  }
  if (
    /\b(no|nope|not urgent|tomorrow|next day|morning|can wait|whenever|no rush)\b/.test(
      m,
    )
  ) {
    return "not_urgent";
  }
  return "unknown";
}

/**
 * Map a customer's answer to the triage URGENCY step onto the canonical urgency
 * enum (0-token). Accepts the chip values verbatim (emergency/high/medium/low)
 * and the common natural phrasings the chips are labeled with ("emergency",
 * "soon"/"today", "this week", "routine"/"whenever"). Returns null when the
 * answer carries no clear urgency, so the caller can defer to the LLM rather
 * than guess. Only called when the urgency step was the pending question.
 */
function parseUrgencyAnswer(message: string): "low" | "medium" | "high" | "emergency" | null {
  const m = message.trim().toLowerCase();
  if (m.length === 0) return null;
  // Exact chip values.
  if (m === "emergency" || m === "high" || m === "medium" || m === "low") {
    return m;
  }
  // Natural phrasings.
  if (/\b(emergency|right now|immediately|can'?t wait|asap)\b/.test(m)) return "emergency";
  if (/\b(soon|today|tonight|urgent|as soon as)\b/.test(m)) return "high";
  if (/\b(this week|few days|couple days|medium)\b/.test(m)) return "medium";
  if (/\b(routine|whenever|no rush|not urgent|can wait|low|sometime)\b/.test(m)) return "low";
  return null;
}

/**
 * Infer WHEN the customer wants the service to happen — the signal that gates
 * the after-hours charge (Fix 2). The charge is keyed to when the technician
 * goes out, NOT when the customer is chatting, so a request explicitly for a
 * business-hours window must never trigger a charge even if chatting at 11pm.
 *
 * Sources, in priority order:
 *   1. The customer's stated preferred window (extras.preferredWindow):
 *      morning/afternoon/evening → business_hours; asap → now.
 *   2. The yes/no answer to our after-hours urgency ask: not_urgent →
 *      business_hours; urgent → now.
 * Otherwise "unknown" — fall back to urgency classification in the helper.
 *
 * Note we deliberately do NOT map a high/emergency urgency to "now" here; the
 * helper already handles urgency directly, and a stated business-hours window
 * should be able to override that heuristic.
 */
function inferBookingTarget(
  preferredWindow: unknown,
  customerSignal: CustomerUrgencySignal,
): BookingTarget {
  if (preferredWindow === "asap") return "now";
  if (
    preferredWindow === "morning" ||
    preferredWindow === "afternoon" ||
    preferredWindow === "evening"
  ) {
    return "business_hours";
  }
  if (customerSignal === "not_urgent") return "business_hours";
  if (customerSignal === "urgent") return "now";
  return "unknown";
}

/** True when the current instant falls in the org's after-hours window — used
 * to gate the LLM after-hours instruction block. Reuses the disclosure helper's
 * window logic (which honors `config.enabled`) so both paths agree. */
function isAfterHoursHintActive(config: AfterHoursConfig): boolean {
  return decideAfterHoursDisclosure({
    clock: new Date(),
    config,
    urgency: null,
    customerSignal: "unknown",
  }).afterHours;
}

/** Single-chunk text/plain response — byte-compatible with the SDK's text stream. */
function cannedTextResponse(text: string): Response {
  return new Response(text, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Graceful degradation: instead of surfacing a raw error to the customer (a red
 * error box) when a turn can't be completed normally — token budget / turn limit
 * reached, or the model call failed — record a warm handoff reply and escalate
 * the session so a human picks it up. Returns the handoff copy as a normal text
 * response so the client renders it as an assistant bubble, not an error.
 *
 * Best-effort: the message insert and escalation are wrapped so a DB blip still
 * returns the handoff copy (the customer always sees a graceful message). Safe to
 * call before any reply has streamed (all the early-gate failure paths qualify).
 */
async function gracefulHandoff(params: {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly currentStatus: SessionState;
  readonly ipAddress: string;
}): Promise<Response> {
  const { organizationId, sessionId, currentStatus, ipAddress } = params;
  try {
    await db.insert(messages).values({
      organizationId,
      sessionId,
      role: "assistant",
      content: HANDOFF_REPLY,
      tokensUsed: 0,
    });
  } catch (insertError: unknown) {
    logger.error(
      { error: insertError, sessionId },
      "Graceful-handoff message insert failed — returning handoff copy anyway",
    );
  }
  try {
    const escResult = await escalateSession({
      organizationId,
      sessionId,
      currentStatus,
      ipAddress,
    });
    if (!escResult.ok && escResult.reason !== "already_transitioned") {
      logger.error(
        { sessionId, reason: escResult.reason },
        "Graceful-handoff escalation did not apply",
      );
    }
  } catch (escError: unknown) {
    logger.error(
      { error: escError, sessionId },
      "Graceful-handoff escalation threw — returning handoff copy anyway",
    );
  }
  return cannedTextResponse(HANDOFF_REPLY);
}

/**
 * Deterministic next-question prompt, driven by the triage engine. Maps the
 * merged slots into the triage shape and asks for the single next question
 * (safety screen → qualifying questions → required fields → enrichment). When
 * the customer has answered/skipped everything, triage returns null and we fall
 * back to a gentle "anything else?" prompt. Quick-reply chips are appended in
 * parentheses so the deterministic (0-token) path still guides the customer.
 *
 * Stage 5.2: when the next step is the preferred-window step, the caller may pass
 * a `windowPrompt` built from REAL open availability (buildWindowPrompt) — we use
 * its question + chips instead of the static "we'll confirm the time" copy so the
 * customer is offered concrete bookable windows. The chip VALUES are unchanged
 * (morning/afternoon/evening/asap), so capture stays deterministic.
 */
function nextSlotPrompt(
  merged: KnownSlots,
  windowPrompt?: { readonly question: string; readonly chips: readonly { readonly label: string }[] },
): string {
  const triageSlots: TriageSlots = {
    issueType: merged.issueType ?? null,
    urgency: merged.urgency ?? null,
    address: merged.address ?? null,
    name: merged.name ?? null,
    phone: merged.phone ?? null,
    email: merged.email ?? null,
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
  // Offer real open windows when we've fetched them for THIS step (5.2).
  if (step.id === "preferred_window" && windowPrompt) {
    const chips =
      windowPrompt.chips.length > 0
        ? ` (${windowPrompt.chips.map((c) => c.label).join(" · ")})`
        : "";
    return windowPrompt.question + chips;
  }
  const chips =
    step.quickReplies.length > 0
      ? ` (${step.quickReplies.map((r) => r.label).join(" · ")})`
      : "";
  return step.question + chips;
}

/** The triage step that would be asked next given the merged slots (same mapping
 * nextSlotPrompt uses). Lets the route decide whether to fetch real availability
 * BEFORE composing the reply, without duplicating the slot→triage mapping. */
function nextStepIdFor(merged: KnownSlots): string | null {
  const step = nextTriageStep({
    issueType: merged.issueType ?? null,
    urgency: merged.urgency ?? null,
    address: merged.address ?? null,
    name: merged.name ?? null,
    phone: merged.phone ?? null,
    email: merged.email ?? null,
    safetyScreenPassed: true,
    extras: { ...(merged.extras ?? {}) },
  });
  return step?.id ?? null;
}

/**
 * Fetch REAL open windows for the next several business days and turn them into
 * the preferred-window prompt (Stage 5.2). Reads through the scheduling-source
 * seam (getOpenAvailability). Best-effort: ANY failure returns null so the caller
 * falls back to the static window question — availability is an enhancement, never
 * a gate on the intake. We offer next-business-day onward (skip today: a same-day
 * booking is the after-hours/urgent path, not the standard "when works best").
 */
async function fetchWindowPrompt(
  organizationId: string,
): Promise<{ readonly question: string; readonly chips: readonly WindowChip[] } | null> {
  try {
    const today = businessTodayIso(new Date());
    // Start at the day AFTER today: businessDaysFrom(today, 8) gives today..+7;
    // we drop today so the offered openings are next-business-day onward.
    const days = businessDaysFrom(today, 8).filter((d) => d !== today);
    const availability = await getOpenAvailability(organizationId, days);
    return buildWindowPrompt(availability);
  } catch (availabilityError: unknown) {
    logger.error(
      { error: availabilityError, organizationId },
      "Failed to fetch open availability for window prompt — using static prompt",
    );
    return null;
  }
}

// Each account capability, keyed by a stable name. The new account_data intents
// map 1:1; the legacy reference intents (which still win the phrase match and
// return as FALLBACK_LLM with their intentId) map to the closest capability so an
// identified customer gets a real answer instead of an LLM punt.
type AccountCapability =
  | "membership"
  | "next_visit"
  | "balance"
  | "appointment"
  | "reschedule";

const ACCOUNT_INTENT_CAPABILITY: Record<string, AccountCapability> = {
  // New v1 account_data intents.
  "account-data-membership-status": "membership",
  "account-data-next-visit": "next_visit",
  "account-data-balance": "balance",
  "account-data-appointment-status": "appointment",
  "account-data-reschedule": "reschedule",
};

// Legacy reference intents the router returns as FALLBACK_LLM (with intentId
// preserved). For an IDENTIFIED session these now resolve to an account tool;
// unidentified sessions never reach this map (they keep the LLM identify path).
// scheduling-cancel is deliberately absent — cancel is NOT in the safe v1 set.
const LEGACY_ACCOUNT_INTENT_TOOL: Record<string, AccountCapability> = {
  "membership-account": "membership",
  "account-check-status": "appointment",
  "account-change-appointment": "reschedule",
  "scheduling-reschedule": "reschedule",
};

/**
 * Dispatch an identified-customer account intent to the matching read-tool and
 * assemble a deterministic, pricing-safe reply. The caller has ALREADY enforced
 * the identity gate (customerId is the resolved, org-scoped customer).
 *
 * The reschedule capability records a STAFF HAND-OFF (a request note) and never
 * mutates the schedule. Money is formatted at the reply layer (account-reply.ts).
 * Returns null for an unrecognized intent id so the caller falls through to the
 * normal path. Reads/writes are awaited HERE (before the response is returned),
 * so on serverless they complete within the request — no detached promise that
 * the platform freeze would kill.
 */
async function buildAccountLookupReply(
  intentId: string | null,
  organizationId: string,
  customerId: string,
  message: string,
): Promise<string | null> {
  const capability =
    (intentId && ACCOUNT_INTENT_CAPABILITY[intentId]) ||
    (intentId && LEGACY_ACCOUNT_INTENT_TOOL[intentId]) ||
    null;
  switch (capability) {
    case "membership": {
      const summary = await getMembershipSummary(organizationId, customerId);
      return membershipReply(summary);
    }
    case "next_visit": {
      const visit = await getNextVisit(organizationId, customerId);
      return nextVisitReply(visit);
    }
    case "balance": {
      const balance = await getOpenBalance(organizationId, customerId);
      return balanceReply(balance);
    }
    case "appointment": {
      const appointment = await getUpcomingAppointment(
        organizationId,
        customerId,
      );
      return appointmentReply(appointment);
    }
    case "reschedule": {
      const handoff = await requestReschedule(
        organizationId,
        customerId,
        message,
      );
      return rescheduleReply(handoff);
    }
    default:
      return null;
  }
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
      // Don't surface a raw 429 — the customer just sees a red error box mid-chat
      // ("it errors out when the conversation gets too long"). Degrade gracefully:
      // connect them to a human and escalate the session instead.
      logger.info(
        { sessionId: session.id, tokensUsed: session.tokensUsed },
        "Token budget exhausted — degrading to human handoff",
      );
      return gracefulHandoff({
        organizationId,
        sessionId: session.id,
        currentStatus: session.status,
        ipAddress: ip,
      });
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

    // Extract attachment IDs from the request body
    const attachmentIds =
      typeof body === "object" &&
      body !== null &&
      "attachments" in body &&
      Array.isArray((body as Record<string, unknown>).attachments)
        ? ((body as Record<string, unknown>).attachments as string[])
            .filter((id): id is string => typeof id === "string")
        : [];

    // Set by the client when the customer picked a result from the address
    // lookup (vs. typing free text). A structured selection is a complete,
    // valid address, so we trust it verbatim at the address step rather than
    // re-running the US-centric regex (which rejects e.g. non-US addresses or
    // ones without a leading house number, causing the address re-ask bug).
    const addressSelected =
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>).addressSelected === true;

    const guardrailResult = sanitizeInput(userMessage);

    // CHATBOT-PLAN Step 4 — graceful injection handling.
    //  - HARD severity (true injection / jailbreak / prompt-extraction): keep the
    //    dead-end 400 hard block. A real injection must NEVER be softened into a
    //    served LLM turn.
    //  - SOFT severity (HVAC-scope false-positive, e.g. a stray "system:"): don't
    //    break the chat with an error box. Save the turn, reply conversationally,
    //    and steer back to HVAC — WITHOUT feeding the flagged text to the model.
    if (guardrailResult.severity === "hard") {
      logger.warn(
        { sessionId: session.id, flagged: guardrailResult.flagged },
        "Guardrail HARD flags detected — blocking request",
      );
      return errorResponse(
        "Your message could not be processed. Please rephrase and try again.",
        "GUARDRAIL_BLOCKED",
        400,
      );
    }

    if (guardrailResult.severity === "soft") {
      logger.info(
        { sessionId: session.id, flagged: guardrailResult.flagged },
        "Guardrail SOFT flags — answering conversationally and continuing",
      );
      // Persist the (sanitized) user turn and a canned in-scope reply so the chat
      // stays coherent; bump the turn count. The flagged text never reaches the LLM.
      const softTurnCount = session.turnCount + 1;
      try {
        await db.insert(messages).values([
          {
            organizationId,
            sessionId: session.id,
            role: "user" as const,
            content: guardrailResult.sanitized,
          },
          {
            organizationId,
            sessionId: session.id,
            role: "assistant" as const,
            content: GUARDRAIL_SOFT_REPLY,
            tokensUsed: 0,
          },
        ]);
        await db
          .update(customerSessions)
          .set({ turnCount: softTurnCount, updatedAt: new Date() })
          .where(sessionScope);
      } catch (softError: unknown) {
        logger.error(
          { error: softError, sessionId: session.id },
          "Guardrail SOFT persistence failed — returning reply anyway",
        );
      }
      return cannedTextResponse(GUARDRAIL_SOFT_REPLY);
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
    const [userMessageRow] = await db
      .insert(messages)
      .values({
        organizationId,
        sessionId: session.id,
        role: "user",
        content: guardrailResult.sanitized,
      })
      .returning();

    // Link uploaded attachments to this message
    if (attachmentIds.length > 0 && userMessageRow) {
      await db
        .update(attachments)
        .set({ messageId: userMessageRow.id })
        .where(
          and(
            eq(attachments.sessionId, session.id),
            // Only link attachments that belong to this session and are in the provided list
            // Using a raw OR clause for the array of IDs
          ),
        );
      // Update each attachment individually to link to the message
      for (const attachmentId of attachmentIds) {
        await db
          .update(attachments)
          .set({ messageId: userMessageRow.id })
          .where(
            and(
              eq(attachments.id, attachmentId),
              eq(attachments.sessionId, session.id),
              eq(attachments.organizationId, organizationId),
            ),
          );
      }
      logger.info(
        {
          messageId: userMessageRow.id,
          attachmentCount: attachmentIds.length,
        },
        "Attachments linked to user message",
      );
    }

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
      email: knownSlots.email ?? null,
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

    // Org overlay (disabled services + businessInfo + companyName + custom
    // FAQs). The deterministic router consumes it AND the LLM path reads its
    // businessInfo/companyName to brand the system prompt — so it's hoisted to
    // the turn scope. Non-critical: if its read fails (DB blip, cold start),
    // degrade to the empty overlay (everything enabled, no personalization)
    // rather than failing the customer's whole turn.
    const routerConfig = await getRouterConfig(organizationId).catch(
      (configError: unknown) => {
        logger.error(
          { error: configError, sessionId: session.id },
          "Failed to load router config — using empty overlay",
        );
        return EMPTY_ORG_CONFIG;
      },
    );

    // After-hours config: read the org's window the SAME way the confirm route
    // does (organizationSettings.afterHoursConfig → resolveAfterHoursConfig), so
    // the customer-facing disclosure and the confirm-time after-hours flag agree
    // on the window. Non-critical: ANY error degrades to a DISABLED config so we never
    // wrongly threaten a charge (resolve returns the default window otherwise).
    const afterHoursConfig = await (async () => {
      try {
        const [row] = await db
          .select({ afterHoursConfig: organizationSettings.afterHoursConfig })
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, organizationId))
          .limit(1);
        return resolveAfterHoursConfig(row?.afterHoursConfig ?? null);
      } catch (cfgError: unknown) {
        logger.error(
          { error: cfgError, sessionId: session.id },
          "Failed to load after-hours config — disabling after-hours disclosure",
        );
        // Disabled → isAfterHours() returns false → decision is "none".
        return resolveAfterHoursConfig({ enabled: false });
      }
    })();

    // Did we ASK "is this urgent?" last turn? (pendingStep === urgency, which
    // we only reach after-hours when urgency was still unknown.) If so, read the
    // customer's yes/no answer as an urgency signal for this turn's decision.
    // We "asked about urgency last turn" when the triage urgency step was
    // pending OR the after-hours ask_urgency move was the LAST disclosure shown
    // (it owns its turn, so the next customer message answers it). Keyed to the
    // LAST shown move only — a "yes" answering offer_next_day's "Want me to do
    // that?" must never be read as "urgent".
    const afterHoursShownPrior = String(
      knownSlots.extras?.afterHoursShown ?? "",
    );
    const askedUrgencyLastTurn =
      pendingStep?.id === "urgency" ||
      (afterHoursShownPrior.split(",").filter(Boolean).pop() ===
        "ask_urgency" &&
        !knownSlots.urgency);
    const urgencySignal: CustomerUrgencySignal = readUrgencySignal(
      askedUrgencyLastTurn,
      guardrailResult.sanitized,
    );

    if (ROUTER_ENABLED) {
      const verdict = routeMessage(
        guardrailResult.sanitized,
        knownSlots,
        routerConfig,
      );

      // ── Account-data intents (identified-customer reads, v1) ──
      // IDENTITY GATE: an ACCOUNT_LOOKUP verdict ("my balance / my membership /
      // my visit / my appointment", or a reschedule REQUEST) is only acted on
      // when the session has an identified customer — session.customerId (linked
      // on a prior turn) OR a customer resolved THIS turn via the blind-index
      // lookup above. For an UNIDENTIFIED session we DELIBERATELY fall through:
      // the verdict's canned reply is the "what's the email/phone on your
      // account?" ask, surfaced by the normal deterministic path below — so we
      // ask the customer to identify, NEVER leaking another customer's data.
      // This block is additive and only handles the identified branch; it never
      // touches the emergency/compound/booking precedence (those are decided
      // inside routeMessage above and short-circuit before any account intent).
      const accountCustomerId =
        session.customerId ?? customerContext?.customerId ?? null;
      // The router emits ACCOUNT_LOOKUP for BOTH the new account_data intents and
      // the carved-out legacy reference intents (account-check-status,
      // account-change-appointment, scheduling-reschedule). We act on it ONLY for
      // an identified session; an unidentified one falls through to the normal
      // deterministic path, which uses the verdict's canned identify-ask reply
      // (no leak). buildAccountLookupReply maps the intentId to the right tool.
      if (verdict.action === "ACCOUNT_LOOKUP" && accountCustomerId) {
        const accountReply = await buildAccountLookupReply(
          verdict.intentId,
          organizationId,
          accountCustomerId,
          guardrailResult.sanitized,
        ).catch((accountError: unknown) => {
          logger.error(
            { error: accountError, sessionId: session.id, intentId: verdict.intentId },
            "Account-lookup failed — degrading to handoff copy",
          );
          return null;
        });

        if (accountReply !== null) {
          const replyText = accountReply + (nearTurnLimit ? ESCALATION_NOTE : "");
          await db.insert(messages).values({
            organizationId,
            sessionId: session.id,
            role: "assistant",
            content: replyText,
            tokensUsed: 0,
          });
          await db
            .update(customerSessions)
            .set({ turnCount: newTurnCount, updatedAt: new Date() })
            .where(sessionScope);
          logger.info(
            {
              sessionId: session.id,
              routed: "deterministic",
              intentId: verdict.intentId,
              action: "ACCOUNT_LOOKUP",
              turnCount: newTurnCount,
            },
            "Chat turn resolved deterministically (0 LLM tokens)",
          );
          return cannedTextResponse(replyText);
        }
        // accountReply === null (unknown intent or a read failed): fall through
        // to the normal path, which degrades gracefully.
      }

      // Multi-field capture: pull EVERY recognizable contact field from this one
      // message (name + phone + email + address), not just the slot the current
      // step expects. Fixes the bug where "ray chen, 4169029212" (name + phone)
      // captured only the phone and the name got re-asked. The residual-name
      // heuristic only fires when a co-field (phone/email/address) is present, so
      // it never guesses a name from prose.
      const allContact = extractAllContactFields(guardrailResult.sanitized);
      const extracted = {
        address: allContact.address,
        phone: allContact.phone,
        email: allContact.email,
      };
      // When we JUST asked for the address (or the city/ZIP follow-up), capture
      // the customer's reply as the address even when the strict extractor would
      // miss it. Two cases:
      //  1. The customer PICKED a result from the address lookup
      //     (addressSelected) — a complete, validated address — so we trust the
      //     whole message verbatim, even a non-US / house-number-less address
      //     ("Route Nationale # 3, Commune Pignon, Nord").
      //  2. The customer TYPED a reply — use the lenient step extractor, which
      //     accepts suffix-less / number-less addresses that still look like an
      //     address (comma, ZIP, or 3+ words) and rejects refusals.
      // This fixes the re-ask bug where such replies fell through every
      // extractor and the bot asked for the address again.
      const atAddressStep =
        pendingStep?.id === "address" || pendingStep?.id === "address_parts";
      const addressAnswer = atAddressStep
        ? addressSelected
          ? guardrailResult.sanitized.trim().slice(0, 500)
          : // The step extractor (purpose-built for "the whole reply IS the
            // address") must win over the loose multi-field extractor here.
            // extracted.address comes from extractAddressLoose, which truncates
            // at the first comma — so a non-US / suffix-less address like
            // "21 Avoca Crescent, Ballarat, Victoria 3350" was being stored as
            // just "21 Avoca Crescent", dropping city/state/postcode and
            // triggering a spurious city/ZIP re-ask loop. Prefer the verbatim
            // step capture; fall back to the loose street only when the step
            // extractor declines (e.g. a refusal/redirect reply).
            extractAddressAtAddressStep(guardrailResult.sanitized) ??
            extracted.address
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
      // Deterministic name capture + correction (0-token). Detect it up front so
      // a NAME-step answer or an explicit "change my …" turn is handled on the
      // deterministic path (filling/overwriting the slot) instead of falling
      // through to the slow LLM. detectCorrection returns the captured name when
      // we just asked for it, or the corrected field+value for an explicit fix.
      const correction = detectCorrection(
        guardrailResult.sanitized,
        pendingStep?.id ?? null,
      );

      const hasContactSlot = Boolean(
        addressAnswer || extracted.phone || extracted.email || allContact.name,
      );
      const isSlotProvision =
        (hasContactSlot || correction !== null) &&
        (Boolean(knownSlots.issueType) || conversationHistory.length > 0);

      // Two-brain fix: when a CORE free-text step is the pending question
      // (name / email / phone / address / city-ZIP follow-up), the customer's
      // reply IS the answer to that step. We MUST stay deterministic and advance,
      // never letting the turn fall through to the LLM, which (seeing a bare
      // "Raymond chen" or "Johnson City 37604") improvises and RE-ASKS a question
      // we already asked. Root cause of the duplicate-question bug in the
      // transcript (address asked 3x, "home or commercial?" asked twice).
      const pendingCoreFreeText =
        pendingStep?.id === "name" ||
        pendingStep?.id === "email" ||
        pendingStep?.id === "phone" ||
        pendingStep?.id === "address" ||
        pendingStep?.id === "address_parts";

      // A bare answer to the triage question we asked LAST turn is capturable on
      // the deterministic path even without a contact slot. Without this, bare
      // enum/free-text answers (system_down, duration, the enrichment steps, and
      // a urgency chip) fall through to the LLM, never get captured, and the
      // stepper re-asks the same question forever. captureEnrichmentAnswer
      // returns non-null only for a RECOGNIZED answer to an extras-backed step
      // (so an unrecognized reply to a required step still defers to the LLM);
      // urgency is a top-level slot, captured when the customer's reply carries
      // a clear urgency signal. The router's emergency short-circuit runs before
      // this (verdict.escalate), so a hazard worded as an "answer" still escalates.
      const pendingAnswerCaptured =
        (pendingStep !== null &&
          (captureEnrichmentAnswer(pendingStep.id, guardrailResult.sanitized) !==
            null ||
            (pendingStep.id === "urgency" &&
              parseUrgencyAnswer(guardrailResult.sanitized) !== null))) ||
        // A clear answer to the after-hours "is this urgent?" ask is a captured
        // answer too: it must persist deterministically (the LLM path stores no
        // slots, so the signal would evaporate and a later turn could disclose
        // a charge the customer already declined).
        (askedUrgencyLastTurn && urgencySignal !== "unknown");

      if (
        verdict.action !== "FALLBACK_LLM" ||
        isSlotProvision ||
        pendingAnswerCaptured ||
        pendingCoreFreeText
      ) {
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
        const capturedExtrasBase = captured
          ? { [captured.key]: captured.value }
          : undefined;

        // Urgency is a top-level slot (not an extras key), so when we just asked
        // the urgency step capture the answer here — chip value or natural
        // phrasing — so "this week" / "routine" advance the stepper without an
        // LLM call. Only when the urgency step was pending, so we never reinterpret
        // an unrelated message as urgency.
        const capturedUrgency =
          pendingStep?.id === "urgency"
            ? parseUrgencyAnswer(guardrailResult.sanitized)
            : undefined;

        // The deterministic correction detected up front (NAME-step answer or an
        // explicit "change my …"). A detected value is passed to mergeSlots as a
        // NON-EMPTY update, which overwrites — the merge only refuses to clobber
        // a filled slot with an EMPTY value, so an explicit correction wins.
        const correctedName =
          correction?.field === "name" ? correction.value : undefined;
        const correctedPhone =
          correction?.field === "phone" ? correction.value : undefined;
        const correctedAddress =
          correction?.field === "address" ? correction.value : undefined;
        const correctedEmail =
          correction?.field === "email" ? correction.value : undefined;

        // If the name we're capturing/correcting this turn is a BUSINESS
        // ("McDonald's", "Joe's Diner", "Acme Refrigeration LLC") rather than a
        // person, treat the job as commercial: pre-set propertyType=commercial
        // (so the "home or commercial?" step is skipped) and flag it so the bot
        // confirms it's for a commercial unit. Only fires on the name being
        // provided THIS turn — we don't re-flag an already-stored name.
        // Residual name from a multi-field dump ("ray chen, 4169029212"): fill
        // the name slot when the message carried one and we don't already have a
        // corrected/seeded name. extractAllContactFields only returns a residual
        // name when a co-field (phone/email/address) is present, so this never
        // guesses a name from prose.
        const residualName = allContact.name ?? undefined;

        const nameThisTurn =
          correctedName ?? residualName ?? seededName ?? null;
        const businessNameDetected =
          nameThisTurn !== null && isBusinessName(nameThisTurn) &&
          knownSlots.extras?.propertyType !== "commercial";
        // Address-validation control flags (persisted in extras, stripped from
        // the final CRM record by the extraction schema):
        //  - addressVerified: the customer picked a geocoded suggestion, so the
        //    address is "found" and trusted even if it isn't a US-ZIP format.
        //  - addressAttempts: bump the re-prompt counter whenever we just asked
        //    the address re-prompt step, so triage stops after the cap instead of
        //    looping on a customer who can't supply a complete US address.
        const addressControl: Record<string, unknown> = {};
        if (addressSelected) {
          addressControl.addressVerified = "yes";
        }
        if (pendingStep?.id === "address_parts") {
          addressControl.addressAttempts =
            Number(knownSlots.extras?.addressAttempts ?? 0) + 1;
        }
        // Email re-ask counter, mirroring addressAttempts: bump whenever the
        // email step was the pending question so triage stops re-asking at
        // MAX_EMAIL_REPROMPTS instead of looping the identical question.
        if (pendingStep?.id === "email") {
          addressControl.emailAttempts =
            Number(knownSlots.extras?.emailAttempts ?? 0) + 1;
        }

        const capturedExtras =
          businessNameDetected ||
          capturedExtrasBase ||
          Object.keys(addressControl).length > 0
            ? {
                ...(capturedExtrasBase ?? {}),
                ...(businessNameDetected ? { propertyType: "commercial" } : {}),
                ...addressControl,
              }
            : undefined;

        // City/ZIP follow-up (address_parts): the customer's reply is normally
        // the missing tail of an address we already have, so we append it to the
        // known street → the engine sees a comma-bearing ("parts handled")
        // address and stops looping. BUT if the customer RE-TYPED a full street
        // address at this step (the loose extractor found a number+street), use
        // that as the base instead of doubling it onto the partial — avoids the
        // "120 Broadway, 120 Broadway, Seattle…" double-address. Falls back to
        // addressAnswer/extracted for all other steps.
        const partsAnswerRaw = guardrailResult.sanitized.trim();
        // A leading digit ("120 Broadway, …") OR a lookup selection (a complete,
        // standalone address) means the customer gave a full address here — use
        // it as the base rather than appending to the stored partial.
        const retypedFullStreet = addressSelected || /^\s*\d/.test(partsAnswerRaw);
        // A reply that parsed as a phone or email is the answer to a DIFFERENT
        // field (customers often answer out of order) — never fold it into the
        // address as a city/ZIP tail or treat it as a re-typed street.
        const partsAnswerIsOtherField =
          extracted.phone !== null || extracted.email !== null;
        const combinedAddress =
          pendingStep?.id === "address_parts" &&
          knownSlots.address &&
          !partsAnswerIsOtherField
            ? (retypedFullStreet
                ? partsAnswerRaw // they re-typed a full street → use it as the base
                : `${knownSlots.address.trim()}, ${partsAnswerRaw}` // append city/ZIP
              ).slice(0, 500)
            : undefined;

        // Merge router + regex-extracted slots into the session metadata. A
        // returning customer's stored name (seededName) fills the name slot so
        // intake skips the name question — mergeSlots never clobbers a name the
        // customer already provided this conversation. A detected correction
        // takes precedence over the seeded/extracted value for its field.
        // An explicit decline at the email step ("skip", "I don't have an
        // email") latches the skip sentinel so the intake proceeds without one
        // instead of re-asking.
        const emailDeclined =
          pendingStep?.id === "email" &&
          (isSkip(guardrailResult.sanitized) ||
            /\bno email\b|\b(?:don'?t|do not) have (?:an |one|email)/i.test(
              guardrailResult.sanitized,
            ));

        // The customer's answer to the after-hours "is this urgent?" ask also
        // fills the urgency slot, so the urgency triage step never re-asks it.
        const signalUrgency =
          askedUrgencyLastTurn && urgencySignal === "urgent"
            ? ("high" as const)
            : askedUrgencyLastTurn && urgencySignal === "not_urgent"
              ? ("medium" as const)
              : undefined;

        const mergedBase = mergeSlots(knownSlots, {
          issueType: verdict.issueType ?? undefined,
          urgency: verdict.urgency ?? capturedUrgency ?? signalUrgency ?? undefined,
          address:
            correctedAddress ?? combinedAddress ?? addressAnswer ?? undefined,
          phone: correctedPhone ?? extracted.phone ?? undefined,
          email:
            correctedEmail ??
            extracted.email ??
            (emailDeclined ? SKIP_SENTINEL : undefined),
          name: correctedName ?? residualName ?? seededName,
          extras: capturedExtras,
        });
        // Email cap: we've asked MAX_EMAIL_REPROMPTS times and still have no
        // email — latch the skip sentinel so completeness/confirm can proceed.
        const emailAttemptsNow = Number(
          addressControl.emailAttempts ??
            knownSlots.extras?.emailAttempts ??
            0,
        );
        const merged =
          !mergedBase.email && emailAttemptsNow >= MAX_EMAIL_REPROMPTS
            ? mergeSlots(mergedBase, { email: SKIP_SENTINEL })
            : mergedBase;

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

        // Stage 5.2: if the next thing to ask is the preferred-window step AND
        // we're going to fall through to the deterministic next-slot prompt
        // (not a canned intent reply / confirm), fetch REAL open windows so we
        // offer concrete bookable bands instead of "we'll confirm the time".
        // Only fetched on this narrow path so we never pay the read on turns
        // that won't ask the window question. Best-effort (null → static copy).
        const willAskWindow =
          !extractionComplete &&
          !(verdict.action !== "FALLBACK_LLM" && verdict.reply) &&
          nextStepIdFor(merged) === "preferred_window";
        const windowPrompt = willAskWindow
          ? await fetchWindowPrompt(organizationId)
          : null;

        // Reply: confirm when complete, else the next question.
        //
        // Residual #1 fix: for a COLLECT_INFO intake intent we DON'T use the
        // intent's canned ask (which hard-codes "what's the service address?",
        // jumping past the triage sequence). We let the deterministic stepper
        // drive — it asks the qualifying questions (system down? how long?)
        // before address, in the researched order. The canned reply is still
        // used for ANSWER / REDIRECT verdicts (an FAQ answer or out-of-scope
        // redirect IS the message; there's no slot to step through).
        // SUBMIT is also excluded: the router's required-slot view (issue/
        // urgency/address) is narrower than the real intake, so its canned
        // confirm copy fires before name/phone/email exist. extractionComplete
        // (computed above from the FULL slot set) owns the confirm decision.
        const useCannedReply =
          verdict.action !== "FALLBACK_LLM" &&
          verdict.action !== "COLLECT_INFO" &&
          verdict.action !== "SUBMIT" &&
          Boolean(verdict.reply);
        // Step 3 — generic re-ask-loop circuit breaker. Track how many turns in a
        // row we've asked the SAME slot question; once it crosses the threshold,
        // swap in re-phrased copy that surfaces "skip" / "talk to a human" so the
        // customer is never trapped repeating themselves (generalizes the old
        // address/email-only caps to any slot). Only applies when we're actually
        // asking a slot question — not on confirm / canned-FAQ / after-hours turns.
        const askingSlotQuestion =
          !extractionComplete && !useCannedReply;
        const nextSlotStepId = askingSlotQuestion
          ? nextStepIdFor(merged)
          : null;
        const reAsk = updateReAskState({
          prevStepId:
            typeof knownSlots.extras?.reAskStepId === "string"
              ? (knownSlots.extras.reAskStepId as string)
              : null,
          prevCount: Number(knownSlots.extras?.reAskCount ?? 0),
          nextStepId: nextSlotStepId,
        });
        const reAskBreakCopy =
          reAsk.shouldBreak && nextSlotStepId
            ? reAskBreakPrompt(nextSlotStepId)
            : null;

        const nextQuestion = extractionComplete
          ? CONFIRM_REPLY
          : useCannedReply
            ? verdict.reply!
            : reAskBreakCopy ?? nextSlotPrompt(merged, windowPrompt ?? undefined);

        // After-hours disclosure (deterministic path). When this intake is
        // happening outside the org's business hours we either ask whether it's
        // urgent, disclose the after-hours charge (urgent — NO dollar amount;
        // the charge depends on the work the team performs), or affirm a no-charge
        // business-hours / next-business-day visit. Emergencies never reach here
        // (they take the ESCALATE branch above), so we never delay a hazard to
        // talk about charges. "none" (business hours / disabled) is a no-op.
        //
        // Fix 2: the charge is keyed to when the technician GOES OUT, not when
        // the customer is chatting. We pass a bookingTarget derived from the
        // customer's stated preferred window / urgency answer so a request for
        // a business-hours slot (e.g. "tomorrow morning") never gets a charge,
        // even when chatting at 11pm.
        const bookingTarget = inferBookingTarget(
          merged.extras?.preferredWindow,
          urgencySignal,
        );
        const afterHoursDecision = decideAfterHoursDisclosure({
          clock: new Date(),
          config: afterHoursConfig,
          urgency: merged.urgency ?? null,
          customerSignal: urgencySignal,
          bookingTarget,
        });

        // Each after-hours move is surfaced AT MOST ONCE per session (the
        // re-prepended preamble was the #1 "bot repeats itself" report), and
        // only on intake turns — never glued onto a canned FAQ answer (a
        // "what are your hours?" reply must not open with "is this urgent?")
        // or onto the confirm copy.
        const shownKinds = afterHoursShownPrior.split(",").filter(Boolean);
        const afterHoursMove =
          afterHoursDecision.kind !== "none" &&
          !extractionComplete &&
          !useCannedReply &&
          !shownKinds.includes(afterHoursDecision.kind)
            ? afterHoursDecision
            : null;
        // After-hours "shown" flag (persisted below in the single consolidated
        // metadata write so it isn't clobbered by the conversation-style write).
        const afterHoursExtras = afterHoursMove
          ? {
              afterHoursShown: [...shownKinds, afterHoursMove.kind].join(","),
            }
          : {};

        // Compose EXACTLY ONE coherent message for this turn (Fix 1). We never
        // stack templates (after-hours line + lead-in + confirm) into one
        // contradictory bubble. The rules:
        //
        //  - Intake COMPLETE: the reply is JUST the confirm copy. No after-hours
        //    line, no warmth lead-in in front of it. (By the time intake
        //    completes for a business-hours booking, Fix 2 means no charge is
        //    disclosed anyway, so there is nothing to weave in.)
        //  - Intake INCOMPLETE + there IS an after-hours move this turn (ask /
        //    disclose / offer): that move OWNS the turn's framing. We use its
        //    copy + the plain next question, with NO separate issue lead-in in
        //    front — one voice only.
        //  - Intake INCOMPLETE + no after-hours move ("none"): use the warmth
        //    lead-in as before.
        // When the customer EXPLICITLY corrected an already-known value (not a
        // first-time name answer to the stepper), acknowledge it so the change
        // is visibly registered rather than silently absorbed. Only for a true
        // correction cue on a field we already had — a fresh NAME-step answer
        // just proceeds normally.
        const isExplicitCorrection =
          correction !== null &&
          !(correction.field === "name" && pendingStep?.id === "name");
        const correctionAck = isExplicitCorrection
          ? `Got it — I've updated your ${correctionFieldLabel(correction!.field)}. `
          : "";

        // When the name they gave is a business, confirm we're treating it as a
        // commercial unit (Spears is commercial-first). Leads the turn so it's
        // clear before the next question. Shown once (businessNameDetected only
        // fires the turn the business name is provided).
        const businessAck = businessNameDetected
          ? `Thanks — I'll log this as a commercial account for ${nameThisTurn}, so we'll send a commercial technician. `
          : "";

        // Combined lead-in for this turn: business clarification then correction
        // ack (at most one of these is usually set).
        const ack = businessAck + correctionAck;

        // Step 1 — rotate the lead-in variant by a stable per-session seed so two
        // consecutive chats don't open identically. Track whether the lead-in
        // actually emits this turn so we can persist the empathy-once flag for the
        // LLM seam (Step 2).
        const leadInSeed = sessionSeed(session.id);
        const emittedLeadIn =
          leadInForIssue(
            merged.issueType,
            merged.urgency,
            newTurnCount,
            leadInSeed,
          ).length > 0;

        let replyBody: string;
        if (extractionComplete) {
          // nextQuestion is CONFIRM_REPLY here — stand-alone, no prefixes EXCEPT
          // an ack so a business/correction change isn't silent.
          replyBody = ack + nextQuestion;
        } else if (afterHoursMove) {
          // The after-hours copy carries the framing for this turn. A copy that
          // ends in a question (the urgency ask, the next-day offer) OWNS the
          // turn — appending the slot question too made two-question bubbles.
          // Statement copies (charge disclosure, no-charge affirmation) lead
          // into the plain next question so it reads as one person talking.
          replyBody = afterHoursMove.copy.trim().endsWith("?")
            ? `${ack}${afterHoursMove.copy}`
            : `${ack}${afterHoursMove.copy} ${nextQuestion}`;
        } else if (reAskBreakCopy) {
          // Step 3 — the re-ask circuit breaker owns the turn's framing: the
          // re-phrased copy already acknowledges the loop and offers skip/human,
          // so no separate warmth lead-in in front of it.
          replyBody = ack + nextQuestion;
        } else if (isExplicitCorrection || businessNameDetected) {
          // A correction / business clarification owns the turn's framing —
          // acknowledge, then ask the next question plainly (one voice).
          replyBody = ack + nextQuestion;
        } else {
          // Conversational warmth (Stage 3b): prepend a brief, varied
          // acknowledgement of the stated issue before the next question —
          // template-based and 0-token. withLeadIn returns "" for emergency
          // urgency, so the exact safety copy is never softened. newTurnCount
          // gates empathy-once; leadInSeed rotates the variant across chats.
          replyBody = withLeadIn(
            nextQuestion,
            merged.issueType,
            merged.urgency,
            newTurnCount,
            leadInSeed,
          );
        }

        // Step 5 — frustration-aware human offer. Accumulate dissatisfaction
        // signals across turns; once they cross the threshold, PROACTIVELY offer a
        // human (once) before the turn-limit fallback. Suppressed when the intake
        // is complete (we're confirming) or an after-hours move owns the turn, so
        // we don't talk over those. The offer leads the reply so it's seen first.
        const frustration = updateFrustration({
          message: guardrailResult.sanitized,
          priorScore: Number(knownSlots.extras?.frustrationScore ?? 0),
          alreadyOffered:
            String(knownSlots.extras?.frustrationOffered ?? "").length > 0,
        });
        const offerHuman =
          frustration.offer &&
          !extractionComplete &&
          !afterHoursMove &&
          // The re-ask breaker already surfaces a human escape this turn — don't
          // stack a second human offer on top of it.
          !reAskBreakCopy;
        if (offerHuman) {
          replyBody = `${FRUSTRATION_HUMAN_OFFER} ${replyBody}`;
        }

        // Persist the conversation-style state (empathy-once flag, re-ask counter,
        // frustration running score/offered) so the next turn — deterministic OR
        // LLM — stays coherent. Folded into the metadata extras in one write.
        metadataStr = JSON.stringify(
          buildExtraction(
            mergeSlots(merged, {
              extras: {
                ...afterHoursExtras,
                ...(emittedLeadIn ? { empathyShown: "1" } : {}),
                reAskStepId: reAsk.stepId ?? "",
                reAskCount: reAsk.count,
                frustrationScore: frustration.total,
                ...(offerHuman ? { frustrationOffered: "1" } : {}),
              },
            }),
            (
              conversationHistory.find((m) => m.role === "user")?.content ??
              guardrailResult.sanitized
            ).slice(0, 280),
          ),
        );

        const replyText = replyBody + (nearTurnLimit ? ESCALATION_NOTE : "");

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

    // Best-effort HCP service-history enrichment (HCP Stage 3): when the resolved
    // customer is linked to HCP, attach a one-line PII-free prior-service note
    // ("last serviced in March") to the context. Behind the seam + degrade-safe:
    // when HCP isn't connected or errors, the context is returned unchanged, so
    // the hint is byte-identical to before. Never blocks/throws on the reply path.
    customerContext = await enrichWithServiceHistory(
      organizationId,
      customerContext,
    ).catch(() => customerContext);

    // Returning-customer note (non-PII: first name + counts/membership) so the
    // model greets them by name, acknowledges prior service, and skips re-asking
    // info already on file. Empty string when not a returning customer.
    const customerContextHint = buildCustomerContextHint(customerContext);

    // Brand the LLM persona from the org's stored config (companyName +
    // businessInfo), populated above via the cached router overlay. Falls back
    // to the generic HVAC persona when nothing is configured (empty BrandInfo).
    const brandPrompt = buildSystemPrompt(
      brandInfoFromConfig(routerConfig.companyName, routerConfig.businessInfo),
    );

    // After-hours instruction block (LLM path). When the request is currently
    // outside the org's business hours, tell the model exactly how to handle
    // the urgent/not-urgent branch and — critically — to disclose the charge
    // WITHOUT quoting a dollar amount (there is no fixed fee; the charge depends
    // on the work performed). Empty string during business hours / when pricing is
    // disabled, so nothing about charges is ever said. We concat it as a
    // SEPARATE block rather than editing the brand persona. Emergencies are
    // never delayed for charge talk: the safety instruction in the brand prompt
    // takes precedence, and this block says so.
    // Suppress the LLM's after-hours coaching once a disclosure has already
    // been made on a deterministic turn — re-explaining the charge every LLM
    // turn is the same repetition bug in another coat.
    const afterHoursAlreadyShown =
      String(knownSlots.extras?.afterHoursShown ?? "").length > 0;
    const afterHoursHint =
      isAfterHoursHintActive(afterHoursConfig) && !afterHoursAlreadyShown
        ? AFTER_HOURS_LLM_INSTRUCTION
        : afterHoursAlreadyShown
          ? "\nAFTER-HOURS: the after-hours situation has ALREADY been explained to this customer. Do NOT bring up after-hours charges or hours again unless the customer asks."
          : "";

    // Tell the model which intake slots this session has ALREADY captured.
    // Deterministic turns persist slots to metadata, but the model never saw
    // them — so on fallback turns it would re-ask for a phone/address already
    // on file (the post-confirm "I still need your address" bug).
    const sessionFacts = [
      knownSlots.issueType ? `issue: ${knownSlots.issueType}` : null,
      knownSlots.urgency ? `urgency: ${knownSlots.urgency}` : null,
      knownSlots.address ? `service address: ${knownSlots.address}` : null,
      knownSlots.phone ? `phone: ${knownSlots.phone}` : null,
      knownSlots.name ? `name: ${knownSlots.name}` : null,
      knownSlots.email && knownSlots.email !== SKIP_SENTINEL
        ? `email: ${knownSlots.email}`
        : knownSlots.email === SKIP_SENTINEL
          ? `email: (customer declined to share one)`
          : null,
    ].filter(Boolean);
    const sessionSlotsHint =
      sessionFacts.length > 0
        ? `\n\nALREADY CAPTURED THIS CONVERSATION (saved — never re-ask or claim you still need these): ${sessionFacts.join("; ")}.`
        : "";

    // Step 2 — carry tone/voice state across the deterministic↔LLM seam. When the
    // deterministic path has already acknowledged the issue once, tell the model
    // NOT to restart the "Got it / Understood" empathy decay, so a chat that
    // alternates deterministic + LLM turns reads as one continuous person rather
    // than two voices. Also nudges tighter replies once several turns deep.
    const empathyAlreadyGiven =
      String(knownSlots.extras?.empathyShown ?? "").length > 0;
    const styleHint = buildStyleHint({
      empathyAlreadyGiven,
      turnCount: newTurnCount,
    });

    // 8. Stream response via Vercel AI SDK per SC-09
    const result = streamText({
      model: await getModel(organizationId),
      system:
        brandPrompt +
        customerContextHint +
        styleHint +
        sessionSlotsHint +
        escalationHint +
        afterHoursHint,
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
          organizationId,
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
        //
        // Residual #2 fix: the DETERMINISTIC router is authoritative for the
        // issue classification of an in-scope request ("blowing warm air" →
        // cooling_not_working). The background LLM extractor is weaker at it and
        // sometimes returns "other", which would clobber the router's correct
        // value (mergeSlots overwrites with any non-empty update). So only let
        // the extractor FILL issueType/urgency when they aren't already set —
        // pass undefined when the fresh metadata already has them.
        const freshSlots = parseKnownSlots(fresh?.metadata ?? null);
        const merged = mergeSlots(freshSlots, {
          issueType: freshSlots.issueType
            ? undefined
            : extraction.extraction.issueType ?? undefined,
          urgency: freshSlots.urgency
            ? undefined
            : extraction.extraction.urgency ?? undefined,
          address: extraction.extraction.address ?? undefined,
          name: extraction.extraction.customerName ?? undefined,
          phone: extraction.extraction.customerPhone ?? undefined,
          email: extraction.extraction.customerEmail ?? undefined,
          // Step 2 — the LLM has produced a reply (and thus acknowledged the
          // issue) this turn, so latch the empathy-once flag so neither the
          // deterministic nor LLM path re-acknowledges on later turns.
          extras: { empathyShown: "1" },
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
    // Degrade gracefully rather than showing the customer a raw 500 error box.
    // We can't reliably escalate here (the session may not have loaded, or the
    // failure is in the stream itself), so we return the warm handoff copy as a
    // normal assistant bubble. The budget/turn-limit paths above DO escalate; a
    // genuine mid-stream model failure is rarer and the customer still gets a
    // human-handoff message instead of an error.
    return cannedTextResponse(HANDOFF_REPLY);
  }
}
