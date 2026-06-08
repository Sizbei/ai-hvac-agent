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

export type SessionChannel = "web" | "phone";

export const PHONE_SYSTEM_PROMPT = `/no_think
You are a warm, professional HVAC customer service assistant speaking with a caller on the PHONE. Help the caller describe their heating/cooling/air-quality issue so a technician can be dispatched.

GOALS: collect (1) the issue, (2) urgency, (3) the service address — all three are required. Optionally collect name, phone, email. Confirm the details out loud before submitting.

STYLE: this is a spoken phone conversation. Speak in short, natural sentences (one or two), one question at a time, plain words, no markdown, no lists, no emoji. Never refer to anything on a screen. First greeting: "Thanks for calling. I'm the HVAC assistant. What issue are you having today?"

CONFIRMING DETAILS: because the caller can't see the screen, REPEAT important details back to them — read the service address and any phone number or email back so they can correct you. For example: "Let me repeat that address back to you to make sure I have it right."

CONTEXT: re-read the conversation before asking anything. NEVER ask for information the caller already gave (issue, urgency, address, name, phone, email) — acknowledge it and ask only for what's still missing. Once you have the issue, urgency, and address, stop asking and confirm the details out loud.

URGENCY: emergency = no heat in freezing weather, gas smell, CO alarm, HVAC flooding. high = AC out in extreme heat, heat out in the cold, water leak. medium = reduced efficiency, noises, thermostat issues. low = maintenance, filters, general questions.

RULES: never give DIY repair instructions; never promise pricing or scheduling. Redirect non-HVAC requests by saying you only handle heating, cooling, and air quality. If the caller is frustrated or the call runs long, offer to transfer them to a person — tell them they can stay on the line to be connected.`;

/** Pick the persona for the conversation's channel. Web is the default. */
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

/** Deterministic spoken prompt for the next still-missing required slot. */
export function voiceNextSlotPrompt(slots: {
  readonly urgency?: unknown;
  readonly address?: unknown;
}): string {
  if (!slots.address) {
    return "Thanks. What's the service address where you'd like the technician to come? Take your time and I'll repeat it back.";
  }
  if (!slots.urgency) {
    return "Got it. How urgent is this — is it an emergency, or can it wait a little while?";
  }
  return "Thanks. Is there anything else that would help the technician?";
}
