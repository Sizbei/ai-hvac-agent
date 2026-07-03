/**
 * POST /api/voice/dial-status — the <Dial action> callback for a warm transfer.
 * Twilio posts the dial OUTCOME here after the transfer call ends, and this
 * response controls what the caller hears next. On a SUCCESSFUL connect we simply
 * hang up (the agent already handled them); only a dial that never connected
 * (busy / no-answer / failed) hears the "we'll call you back" fallback — which
 * previously played even after a successful transfer where the agent hung up
 * first (audit #38).
 */
import { parseAndVerifyTwilioRequest, resolveVoiceMode } from "@/lib/voice/request";
import {
  sayThenHangupTwiML,
  hangupTwiML,
  TWIML_HEADERS,
} from "@/lib/voice/twiml";

export async function POST(request: Request): Promise<Response> {
  const { params, valid } = await parseAndVerifyTwilioRequest(request);
  if (!valid) {
    return new Response(hangupTwiML(), { status: 403, headers: TWIML_HEADERS });
  }

  // 'completed' = the transfer connected and finished normally → just hang up.
  // Anything else (busy, no-answer, failed, canceled) → speak the fallback.
  if (params.DialCallStatus === "completed") {
    return new Response(hangupTwiML(), { headers: TWIML_HEADERS });
  }

  const url = new URL(request.url);
  const fallback =
    url.searchParams.get("fallback") ??
    "I'm sorry, we couldn't connect you. We'll call you back as soon as possible.";
  const voice = resolveVoiceMode(request, Date.now());
  return new Response(sayThenHangupTwiML(fallback, voice), {
    headers: TWIML_HEADERS,
  });
}
