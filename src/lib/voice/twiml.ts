/**
 * TwiML response builders for the Twilio voice webhooks.
 *
 * TwiML is the XML Twilio expects back from a webhook to drive the call. These
 * are small pure string builders (no SDK dependency) so they unit-test in
 * isolation. All caller-derived text is XML-escaped to keep the document
 * well-formed regardless of what the agent or summary contains.
 */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/** Escape the five XML special characters in spoken text. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
  const repromptLine = reprompt
    ? `\n  <Say>${escapeXml(reprompt)}</Say>`
    : "";
  return `${XML_DECL}
<Response>
  <Gather input="speech" action="${escapeXml(action)}" method="POST" speechTimeout="auto">
    <Say>${escapeXml(say)}</Say>
  </Gather>${repromptLine}
</Response>`;
}

/** Speak a final message, then hang up. */
export function sayThenHangupTwiML(say: string): string {
  return `${XML_DECL}
<Response>
  <Say>${escapeXml(say)}</Say>
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
