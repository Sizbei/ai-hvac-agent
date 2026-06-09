/**
 * ElevenLabs text-to-speech client for the phone channel.
 *
 * Twilio's <Say> verb can only speak Twilio/Polly voices — to use an ElevenLabs
 * voice we synthesize the reply to MP3 ourselves and hand Twilio a <Play> URL
 * pointing at our own /api/voice/tts route, which calls this synthesizer.
 *
 * The voice is gated on ELEVENLABS_API_KEY: when it's unset the phone routes
 * fall back to the Polly neural <Say> voice (see twiml.ts), so telephony keeps
 * working with zero ElevenLabs configuration.
 *
 * Defaults to "Davis" (a warm, professional middle-aged American male voice)
 * and the low-latency eleven_turbo_v2_5 model, both overridable per deployment.
 * No SDK dependency — a single fetch keeps this trivially testable.
 */

/** Davis — warm, professional middle-aged American male voice. */
export const DEFAULT_ELEVENLABS_VOICE_ID = "Z2fsAwk7IblvPhYzfslC";

/** Turbo v2.5 — ElevenLabs' low-latency model, best fit for live phone turns. */
export const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_turbo_v2_5";

/**
 * MP3 at 22.05kHz/32kbps — telephone audio is narrowband (~8kHz), so a higher
 * bitrate buys nothing on a call and only adds synthesis + transfer latency.
 */
const OUTPUT_FORMAT = "mp3_22050_32";

const API_BASE = "https://api.elevenlabs.io/v1/text-to-speech";

/**
 * Hard cap on synthesized characters. ElevenLabs bills per character, and a
 * single spoken phone reply should never approach this — a pathologically long
 * agent reply is refused here so it degrades to the Polly <Say> fallback rather
 * than burning quota on a paragraph no caller wants read aloud.
 */
const MAX_SYNTHESIS_CHARS = 1500;

export interface ElevenLabsConfig {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly modelId: string;
}

/** Whether ElevenLabs voice synthesis is configured for this deployment. */
export function isElevenLabsEnabled(): boolean {
  return (process.env.ELEVENLABS_API_KEY?.trim().length ?? 0) > 0;
}

/**
 * Resolve config from the environment, or null when no API key is set (caller
 * should fall back to Polly <Say>). Voice/model env overrides only take effect
 * when a key is present.
 */
export function getElevenLabsConfig(): ElevenLabsConfig | null {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return null;

  const voiceId =
    process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE_ID;
  const modelId =
    process.env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_ELEVENLABS_MODEL_ID;

  return { apiKey, voiceId, modelId };
}

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

/**
 * Synthesize `text` to MP3 bytes. `fetchImpl` is injectable for tests so the
 * real network is never touched in unit tests. Throws ElevenLabsError on a
 * missing key or a non-2xx response so callers can degrade to <Say>.
 */
export async function synthesizeSpeech(
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ArrayBuffer> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new ElevenLabsError("Cannot synthesize empty text");
  }
  if (trimmed.length > MAX_SYNTHESIS_CHARS) {
    throw new ElevenLabsError(
      `Text exceeds ${MAX_SYNTHESIS_CHARS}-char synthesis cap`,
    );
  }

  const config = getElevenLabsConfig();
  if (!config) {
    throw new ElevenLabsError("ELEVENLABS_API_KEY is not configured");
  }

  const url = `${API_BASE}/${encodeURIComponent(
    config.voiceId,
  )}?output_format=${OUTPUT_FORMAT}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "xi-api-key": config.apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: trimmed,
        model_id: config.modelId,
        // A touch of stability + similarity reads as a steady, human service
        // rep rather than an over-emotive narrator.
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
  } catch (cause) {
    throw new ElevenLabsError(
      `ElevenLabs request failed: ${
        cause instanceof Error ? cause.message : "network error"
      }`,
    );
  }

  if (!res.ok) {
    // The body may carry an ElevenLabs error JSON; surface a short hint without
    // leaking the full payload into logs.
    throw new ElevenLabsError(
      `ElevenLabs returned ${res.status}`,
      res.status,
    );
  }

  return res.arrayBuffer();
}
