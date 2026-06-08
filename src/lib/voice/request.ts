/**
 * Shared inbound-webhook plumbing for the Twilio voice routes: parse the
 * application/x-www-form-urlencoded body Twilio posts, and validate the
 * X-Twilio-Signature over the reconstructed URL + those params.
 */
import { getTwilioConfig, reconstructWebhookUrl } from "./config";
import { validateTwilioSignature } from "./twilio-signature";

export interface ParsedVoiceRequest {
  readonly params: Record<string, string>;
  readonly valid: boolean;
}

/**
 * Read the form body and verify the Twilio signature. Returns the flattened
 * params and whether the request is authentic. Fails closed on any error.
 */
export async function parseAndVerifyTwilioRequest(
  request: Request,
): Promise<ParsedVoiceRequest> {
  let params: Record<string, string> = {};
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
