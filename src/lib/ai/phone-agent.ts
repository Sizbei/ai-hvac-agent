/**
 * Telephone sub-agent persona.
 *
 * The phone agent is NOT a fork of the chat agent — it runs the same
 * deterministic router, slot extraction, and state machine. What differs is the
 * PERSONA: a voice call has no screen, so replies must be spoken-friendly (no
 * markdown, no "tap a button", contact details repeated back for confirmation,
 * and human hand-off is "stay on the line" rather than a tap target).
 *
 * This module owns the phone system prompt and the text transforms that turn a
 * chat-style reply into something a text-to-speech engine should read aloud.
 * It's pure (no I/O) so it unit-tests without a DB or telephony provider.
 */
import { SYSTEM_PROMPT } from "./system-prompt";
import { nextTriageStep, type TriageSlots } from "./triage";

export type SessionChannel = "web" | "phone" | "sms";

export const PHONE_SYSTEM_PROMPT = `/no_think
You are a warm, professional HVAC customer service assistant speaking with a caller on the PHONE. Help the caller describe their heating/cooling/air-quality issue so a technician can be dispatched.

GOALS: collect (1) the issue, (2) urgency, (3) the complete service address (street, city, state, and ZIP), (4) the caller's full name (first and last), and (5) a contact phone number. All five are required. You may also collect an email. Confirm the details out loud before submitting.

STYLE: this is a spoken phone conversation. Speak in short, natural sentences (one or two), one question at a time, plain words, no markdown, no lists, no emoji. Never refer to anything on a screen. First greeting: "Thanks for calling. I'm the HVAC assistant. What issue are you having today?"

CONFIRMING DETAILS: because the caller can't see the screen, REPEAT important details back to them. Read the service address and any phone number or email back so they can correct you. For example: "Let me repeat that address back to you to make sure I have it right."

CONTEXT: re-read the conversation before asking anything. NEVER ask for information the caller already gave (issue, urgency, address, name, phone, email). Acknowledge it and ask only for what's still missing. If the caller gives only part of an address, acknowledge what you have and ask specifically for the missing parts, such as the city, state, or ZIP. Never treat a partial address as complete. Once you have the issue, urgency, complete address, full name, and phone, stop asking and confirm the details out loud.

URGENCY: emergency = no heat in freezing weather, gas smell, CO alarm, HVAC flooding. high = AC out in extreme heat, heat out in the cold, water leak. medium = reduced efficiency, noises, thermostat issues. low = maintenance, filters, general questions.

RULES: never give DIY repair instructions; never promise pricing or scheduling. Redirect non-HVAC requests by saying you only handle heating, cooling, and air quality. If the caller is frustrated or the call runs long, offer to transfer them to a person, and tell them they can stay on the line to be connected.`;

/**
 * Pick the persona for the conversation's channel. The phone persona is tuned
 * for a spoken call (short sentences, read details back, "can't see a screen").
 * SMS is written text the customer can read, so it uses the default web persona
 * rather than the voice one. Web is the default.
 */
export function selectSystemPrompt(channel: SessionChannel): string {
  return channel === "phone" ? PHONE_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

// The chat route appends a "tap Talk to a Human" affordance and uses markdown.
// On a call neither makes sense; this strips them and rewrites the hand-off.
const TAP_HUMAN_PATTERN =
  /\s*if you'?d prefer to speak with a human[^.]*\.?/gi;

/**
 * Convert a chat-style assistant reply into text suitable for text-to-speech:
 * strip markdown emphasis, drop the "tap a button" escalation affordance,
 * collapse blank lines into spoken pauses, and (near the turn limit) append a
 * spoken human-transfer offer.
 */
export function toSpokenReply(
  reply: string,
  opts: { readonly nearLimit?: boolean } = {},
): string {
  let spoken = reply
    // Remove the screen-only escalation sentence in any phrasing.
    .replace(TAP_HUMAN_PATTERN, "")
    // Strip common markdown emphasis markers.
    .replace(/\*\*/g, "")
    .replace(/[*_`]/g, "")
    // Collapse newlines (and the blank lines around stripped content) into a
    // single spoken space.
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (opts.nearLimit) {
    spoken = `${spoken} If you'd like, you can stay on the line and I'll connect you with a person.`.trim();
  }

  return spoken;
}

// Spoken phrasing per triage step. A phone call shouldn't drag through all 11
// enrichment questions, so voice asks the required sequence plus a few
// high-value spoken extras (system type, preferred window); the rest are left
// for the technician to confirm on arrival.
const VOICE_STEP_PHRASING: Record<string, string> = {
  safety_screen:
    "First, a quick safety check. Do you smell gas, smell anything burning, hear a carbon monoxide alarm, or have water flooding? If none of those, just say no.",
  system_down: "Is the system completely down, or is it still partly working?",
  duration: "And how long has this been going on?",
  address:
    "What's the service address where you'd like the technician to come? Take your time and I'll repeat it back.",
  address_parts:
    "Let's make sure a technician can find you. What's the full address — street number, street, city, state, and 5-digit ZIP code?",
  phone: "What's the best phone number for our team to reach you?",
  urgency:
    "How urgent is this? Is it an emergency, or can it wait a little while?",
  system_type:
    "Do you know what kind of system it is? Central air, a furnace, a heat pump, a mini-split, or a boiler? You can say you're not sure.",
  preferred_window:
    "Any preference on time of day? Morning, afternoon, or evening? Our team coordinates the actual time with you.",
};

// Steps voice will actually ask (keeps a call from dragging). Everything else is
// captured on the web channel or confirmed by the technician.
const VOICE_ASKABLE = new Set(Object.keys(VOICE_STEP_PHRASING));

// In-loop sentinel used to advance past a CORE triage step (gated on a slot
// value, not on `skipped`) that voice won't ask — e.g. NAME_STEP. Local to the
// sequencing loop in voiceNextSlotPrompt; never persisted to real slots.
const VOICE_SKIPPED_CORE = "__voice_skipped__";

/**
 * Deterministic spoken prompt for the next still-needed slot, driven by the
 * shared triage engine but rendered for voice and limited to the steps that
 * make sense on a call.
 */
export function voiceNextSlotPrompt(slots: {
  readonly issueType?: unknown;
  readonly urgency?: unknown;
  readonly address?: unknown;
  readonly name?: unknown;
  readonly phone?: unknown;
  readonly extras?: Record<string, unknown>;
}): string {
  let triageSlots: TriageSlots = {
    issueType: (slots.issueType as string | null) ?? null,
    urgency: (slots.urgency as string | null) ?? null,
    address: (slots.address as string | null) ?? null,
    name: (slots.name as string | null) ?? null,
    phone: (slots.phone as string | null) ?? null,
    email: null,
    safetyScreenPassed: true,
    extras: { ...(slots.extras ?? {}) },
  };

  // Advance through any triage step voice won't ask (treat as skipped) so we
  // land on the next voice-appropriate question (or run out → wrap up).
  // Optional/enrichment steps are gated on extraFilledOrSkipped, so marking
  // `skipped` advances them. Core fields (name, etc.) are gated on the slot
  // value itself, so we mark a sentinel on the field to advance past a core
  // step voice doesn't ask (e.g. NAME_STEP — name is collected on web / by the
  // technician, not over the phone).
  for (let i = 0; i < 20; i++) {
    const step = nextTriageStep(triageSlots);
    if (!step) break;
    if (VOICE_ASKABLE.has(step.id)) {
      return VOICE_STEP_PHRASING[step.id];
    }
    // CORE steps are gated on the slot VALUE (not `skipped`), so advance them by
    // setting the slot to a local sentinel. name + email are collected on web /
    // confirmed by the tech, not asked over the phone.
    triageSlots =
      step.id === "name"
        ? { ...triageSlots, name: VOICE_SKIPPED_CORE }
        : step.id === "email"
          ? { ...triageSlots, email: VOICE_SKIPPED_CORE }
          : {
              ...triageSlots,
              skipped: { ...(triageSlots.skipped ?? {}), [step.id]: true },
            };
  }
  return "Thanks. Is there anything else that would help the technician?";
}
