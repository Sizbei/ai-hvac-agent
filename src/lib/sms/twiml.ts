/**
 * Messaging TwiML builder for the Twilio inbound-SMS webhook.
 *
 * Twilio expects an XML <Response> with a <Message> verb back from the webhook;
 * it sends that text to the number that messaged in. A small pure string
 * builder (no SDK dependency) so it unit-tests in isolation. The reply text is
 * XML-escaped to keep the document well-formed regardless of agent output.
 */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/** Escape the five XML special characters in message text. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A <Message> response that texts `body` back to the sender. */
export function messagingTwiML(body: string): string {
  return `${XML_DECL}
<Response>
  <Message>${escapeXml(body)}</Message>
</Response>`;
}

/** An empty <Response> — accept the message with no reply. */
export function emptyMessagingTwiML(): string {
  return `${XML_DECL}
<Response></Response>`;
}

/** Standard messaging TwiML response headers. */
export const MESSAGING_HEADERS = {
  "content-type": "text/xml; charset=utf-8",
} as const;
