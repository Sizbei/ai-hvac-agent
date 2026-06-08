/**
 * TwiML response builders for the Twilio voice webhooks.
 *
 * TwiML is the XML Twilio expects back from a webhook to drive the call. These
 * are small pure string builders (no SDK dependency) so they unit-test in
 * isolation. All caller-derived text is XML-escaped to keep the document
 * well-formed regardless of what the agent or summary contains.
 */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * Default spoken voice — an Amazon Polly NEURAL voice (natural, far better than
 * Twilio's legacy standard voices). Overridable per deployment via TWILIO_VOICE
 * (any value Twilio's <Say voice=...> accepts, e.g. "Polly.Matthew-Neural").
 */
export const DEFAULT_VOICE = "Polly.Joanna-Neural";

/** Resolve the configured TTS voice at call time (env override or default). */
function resolveVoice(): string {
  const v = process.env.TWILIO_VOICE?.trim();
  return v && v.length > 0 ? v : DEFAULT_VOICE;
}

/** Escape the five XML special characters in spoken text. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A <Say> verb that speaks `text` with the configured neural voice. */
function sayVerb(text: string): string {
  return `<Say voice="${escapeXml(resolveVoice())}">${escapeXml(text)}</Say>`;
}

/**
 * A <Gather> that collects the caller's speech and POSTs the result to `action`.
 * Speaks `say` first; if a `reprompt` is given it follows the Gather so Twilio
 * reads it when the caller stays silent (then the call can be re-driven).
 */
export function gatherTwiML(params: {
  readonly say: string;
  readonly action: string;
  readonly reprompt?: string;
}): string {
  const { say, action, reprompt } = params;
  const repromptLine = reprompt ? `\n  ${sayVerb(reprompt)}` : "";
  return `${XML_DECL}
<Response>
  <Gather input="speech" action="${escapeXml(action)}" method="POST" speechTimeout="auto">
    ${sayVerb(say)}
  </Gather>${repromptLine}
</Response>`;
}

/** Speak a final message, then hang up. */
export function sayThenHangupTwiML(say: string): string {
  return `${XML_DECL}
<Response>
  ${sayVerb(say)}
  <Hangup/>
</Response>`;
}

/** Bare hang-up (e.g. unrecoverable error). */
export function hangupTwiML(): string {
  return `${XML_DECL}
<Response>
  <Hangup/>
</Response>`;
}

/** Standard TwiML response headers. */
export const TWIML_HEADERS = {
  "content-type": "text/xml; charset=utf-8",
} as const;
