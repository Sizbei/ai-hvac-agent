/**
 * Shared inbound-webhook plumbing for the Twilio voice routes: parse the
 * application/x-www-form-urlencoded body Twilio posts, and validate the
 * X-Twilio-Signature over the reconstructed URL + those params.
 */
import { getTwilioConfig, reconstructWebhookUrl } from "./config";
import { validateTwilioSignature } from "./twilio-signature";
import { isElevenLabsEnabled } from "./elevenlabs";
import { POLLY_VOICE, type VoiceMode } from "./twiml";

export interface ParsedVoiceRequest {
  readonly params: Record<string, string>;
  readonly valid: boolean;
}

/**
 * The absolute origin Twilio reached us on (scheme + host, no path). Used to
 * build absolute <Play> URLs for the ElevenLabs TTS route — Twilio requires
 * absolute media URLs, and anchoring on the forwarded host keeps it correct
 * behind Vercel's proxy and across preview/prod domains.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto =
    request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    url.host;
  return `${proto}://${host}`;
}

/**
 * Choose how to voice replies for this request.
 *
 * DEFAULT = ElevenLabs <Play> whenever a key is configured (isElevenLabsEnabled)
 * — the warmer "Brian" voice is used automatically, no VOICE_PROVIDER flag
 * required. Escape hatch: set VOICE_PROVIDER=polly to force the Polly <Say>
 * voice even when a key is present (single voice, no synthesis round-trip, lowest
 * latency). With no key configured we always fall back to Polly.
 */
export function resolveVoiceMode(request: Request, now: number): VoiceMode {
  const provider = process.env.VOICE_PROVIDER?.trim().toLowerCase();
  if (provider === "polly") {
    return POLLY_VOICE;
  }
  if (isElevenLabsEnabled()) {
    return { kind: "elevenlabs", baseUrl: requestOrigin(request), now };
  }
  return POLLY_VOICE;
}

/**
 * Read the form body and verify the Twilio signature. Returns the flattened
 * params and whether the request is authentic. Fails closed on any error.
 */
export async function parseAndVerifyTwilioRequest(
  request: Request,
): Promise<ParsedVoiceRequest> {
  const params: Record<string, string> = {};
  try {
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      params[key] = typeof value === "string" ? value : "";
    }
  } catch {
    return { params: {}, valid: false };
  }

  const { authToken } = getTwilioConfig();
  const signature = request.headers.get("x-twilio-signature");
  const url = reconstructWebhookUrl(
    request,
    request.headers.get("x-forwarded-proto"),
    request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  );

  const valid = validateTwilioSignature({ authToken, signature, url, params });
  return { params, valid };
}
