/**
 * TwiML response builders for the Twilio voice webhooks.
 *
 * TwiML is the XML Twilio expects back from a webhook to drive the call. These
 * are small pure string builders (no SDK dependency) so they unit-test in
 * isolation. All caller-derived text is XML-escaped to keep the document
 * well-formed regardless of what the agent or summary contains.
 *
 * Two ways to voice text:
 *  - Polly <Say>: Twilio's own neural TTS. Near-instant, the default.
 *  - ElevenLabs <Play>: when ELEVENLABS_API_KEY is set, the route synthesizes
 *    the reply to MP3 via /api/voice/tts and Twilio plays it. Warmer/custom
 *    voice at the cost of a synthesis round-trip per turn.
 * The mode is chosen by the route and passed in as `voice` so these builders
 * stay pure and env-free. ElevenLabs mode still emits a Polly <Say> fallback
 * (after the <Play>) so a synthesis failure degrades to a spoken line rather
 * than silence.
 */
import { createTtsToken } from "./tts-token";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * Default spoken voice when ElevenLabs is not configured — an Amazon Polly
 * NEURAL voice (natural, far better than Twilio's legacy standard voices). Ruth
 * is the warmest, most natural US English neural voice. Overridable per
 * deployment via TWILIO_VOICE (any value Twilio's <Say voice=...> accepts).
 */
export const DEFAULT_VOICE = "Polly.Ruth-Neural";

/** Resolve the configured Polly TTS voice (env override or default). */
function resolvePollyVoice(): string {
  const v = process.env.TWILIO_VOICE?.trim();
  return v && v.length > 0 ? v : DEFAULT_VOICE;
}

/**
 * How to voice spoken text. `polly` uses <Say>; `elevenlabs` plays a synthesized
 * MP3 from /api/voice/tts at `baseUrl` (the absolute origin Twilio reached us
 * on), passing the signed token via the URL. `now` stamps the token expiry.
 */
export type VoiceMode =
  | { readonly kind: "polly" }
  | { readonly kind: "elevenlabs"; readonly baseUrl: string; readonly now: number };

/** Polly is the safe default whenever ElevenLabs isn't explicitly selected. */
export const POLLY_VOICE: VoiceMode = { kind: "polly" };

/** Escape the five XML special characters in spoken text. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A <Say> verb that speaks `text` with the configured Polly neural voice. */
function pollySay(text: string): string {
  return `<Say voice="${escapeXml(resolvePollyVoice())}">${escapeXml(text)}</Say>`;
}

/** Build the absolute /api/voice/tts URL that synthesizes `text` via ElevenLabs. */
function ttsPlayUrl(text: string, baseUrl: string, now: number): string {
  const token = createTtsToken(text, now);
  const u = new URL("/api/voice/tts", baseUrl);
  u.searchParams.set("text", token.text);
  u.searchParams.set("exp", String(token.expiresAt));
  u.searchParams.set("sig", token.sig);
  return u.toString();
}

/**
 * Render a spoken line for the given voice mode. In ElevenLabs mode this is a
 * <Play> of the synthesized MP3 followed by a <Say> fallback, so a TTS failure
 * (the route 500s and Twilio can't play it) still leaves the caller a spoken
 * line rather than dead air.
 */
function speak(text: string, voice: VoiceMode): string {
  if (voice.kind === "elevenlabs") {
    // <Play> ONLY — emitting a <Say> after it made Twilio voice the line TWICE
    // (the MP3 then Polly reading the same text). On a failed media fetch Twilio
    // simply moves on to the next verb (the surrounding <Gather> re-prompts), so
    // there's no dead-air risk that needs a second spoken copy.
    const url = ttsPlayUrl(text, voice.baseUrl, voice.now);
    return `<Play>${escapeXml(url)}</Play>`;
  }
  return pollySay(text);
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
  readonly voice?: VoiceMode;
}): string {
  const { say, action, reprompt, voice = POLLY_VOICE } = params;
  const repromptLine = reprompt ? `\n  ${speak(reprompt, voice)}` : "";
  return `${XML_DECL}
<Response>
  <Gather input="speech" action="${escapeXml(action)}" method="POST" speechTimeout="${resolveSpeechTimeout()}">
    ${speak(say, voice)}
  </Gather>${repromptLine}
</Response>`;
}

/**
 * How long Twilio waits after the caller stops speaking before submitting the
 * <Gather>. Twilio only accepts whole seconds or "auto" (fractional values like
 * 1.5 are rejected). Human conversational turn-taking pauses are ~200ms and feel
 * "done" by ~1s, so 1s is the most natural-feeling fixed value; "auto" detects a
 * natural pause but errs toward waiting longer (laggy). Default 1s; override with
 * TWILIO_SPEECH_TIMEOUT ("auto" or a whole number of seconds) — bump to 2 if real
 * calls show slow talkers getting clipped mid-answer.
 */
function resolveSpeechTimeout(): string {
  const v = process.env.TWILIO_SPEECH_TIMEOUT?.trim();
  if (v && (v === "auto" || /^\d+$/.test(v))) return v;
  return "1";
}

/** Speak a final message, then hang up. */
export function sayThenHangupTwiML(
  say: string,
  voice: VoiceMode = POLLY_VOICE,
): string {
  return `${XML_DECL}
<Response>
  ${speak(say, voice)}
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
