import { NextRequest } from "next/server";
import { verifyTtsToken } from "@/lib/voice/tts-token";
import { synthesizeSpeech, isElevenLabsEnabled } from "@/lib/voice/elevenlabs";
import { slidingWindow } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

/**
 * Public TTS endpoint that Twilio's media servers fetch (via a <Play> URL the
 * voice routes embed in their TwiML). It synthesizes the reply text to MP3 with
 * ElevenLabs and streams it back.
 *
 * Twilio fetches this without a webhook signature, so the request is
 * authenticated by the HMAC token in the query string (see tts-token.ts): only
 * text this app signed — and only within a short expiry — is ever synthesized,
 * so the route can't be turned into an open ElevenLabs proxy. On any failure we
 * return a non-2xx so Twilio falls through to the Polly <Say> fallback that the
 * TwiML always includes after the <Play>.
 */
export async function GET(request: NextRequest) {
  if (!isElevenLabsEnabled()) {
    // No key configured — the routes shouldn't be emitting <Play> at all, but
    // fail safe if a stale URL is fetched.
    return new Response("Not configured", { status: 404 });
  }

  // A valid token is replayable until it expires; cap burst synthesis per IP so
  // a leaked URL can't be hammered to run up ElevenLabs cost within the window.
  const ip = clientIp(request);
  const rate = slidingWindow(`tts:${ip}`, 30, 60_000);
  if (!rate.allowed) {
    return new Response("Too Many Requests", { status: 429 });
  }

  const url = new URL(request.url);
  const sig = url.searchParams.get("sig") ?? undefined;
  const text = verifyTtsToken(
    {
      text: url.searchParams.get("text") ?? undefined,
      expiresAt: Number(url.searchParams.get("exp")),
      sig,
    },
    Date.now(),
  );

  if (text === null) {
    // Log IP + sig length (never the value) so probing/replay is detectable.
    logger.warn(
      { ip, sigLen: sig?.length ?? 0 },
      "Rejected TTS request: invalid or expired token",
    );
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const audio = await synthesizeSpeech(text);
    return new Response(audio, {
      headers: {
        "content-type": "audio/mpeg",
        // Call-specific audio tied to a short-lived token — never cache it in a
        // shared cache. Twilio fetches it once per <Play>.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    logger.error({ error }, "ElevenLabs synthesis failed");
    // 502 → Twilio can't play the media and reads the <Say> fallback instead.
    return new Response("Synthesis failed", { status: 502 });
  }
}
