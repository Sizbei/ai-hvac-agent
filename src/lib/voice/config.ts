/**
 * Twilio voice configuration, read from the environment.
 *
 * The auth token is required to validate inbound webhook signatures; without it
 * signature validation fails closed (every request is rejected) so the voice
 * endpoints can't be driven by a forged request when telephony isn't set up.
 */

export interface TwilioConfig {
  readonly authToken: string | undefined;
  readonly accountSid: string | undefined;
}

export function getTwilioConfig(): TwilioConfig {
  return {
    authToken: process.env.TWILIO_AUTH_TOKEN,
    accountSid: process.env.TWILIO_ACCOUNT_SID,
  };
}

/**
 * The absolute URL Twilio used to reach a webhook — required to recompute the
 * request signature. Behind Vercel's proxy the inbound URL's protocol/host can
 * differ from what Twilio signed, so prefer the forwarded headers when present.
 */
export function reconstructWebhookUrl(
  request: Request,
  forwardedProto: string | null,
  forwardedHost: string | null,
): string {
  const url = new URL(request.url);
  const proto = forwardedProto ?? url.protocol.replace(":", "");
  const host = forwardedHost ?? url.host;
  return `${proto}://${host}${url.pathname}`;
}
