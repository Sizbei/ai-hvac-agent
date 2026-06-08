import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { validateTwilioSignature, computeTwilioSignature } from "./twilio-signature";

const AUTH_TOKEN = "test_auth_token_123";

/** Reference implementation of Twilio's scheme, used to produce valid fixtures. */
function reference(url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac("sha1", AUTH_TOKEN).update(data, "utf8").digest("base64");
}

describe("computeTwilioSignature", () => {
  it("matches Twilio's documented algorithm (url + sorted params, HMAC-SHA1, base64)", () => {
    const url = "https://example.com/api/voice/gather";
    const params = { CallSid: "CA123", From: "+15550000000", SpeechResult: "no heat" };
    expect(computeTwilioSignature(AUTH_TOKEN, url, params)).toBe(
      reference(url, params),
    );
  });

  it("is order-independent in the params (Twilio sorts by key)", () => {
    const url = "https://example.com/x";
    const a = computeTwilioSignature(AUTH_TOKEN, url, { b: "2", a: "1" });
    const b = computeTwilioSignature(AUTH_TOKEN, url, { a: "1", b: "2" });
    expect(a).toBe(b);
  });
});

describe("validateTwilioSignature", () => {
  const url = "https://example.com/api/voice/incoming";
  const params = { CallSid: "CA999", From: "+15551112222" };

  it("accepts a correct signature", () => {
    const sig = reference(url, params);
    expect(
      validateTwilioSignature({ authToken: AUTH_TOKEN, signature: sig, url, params }),
    ).toBe(true);
  });

  it("rejects a tampered signature", () => {
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        signature: "not-the-right-signature",
        url,
        params,
      }),
    ).toBe(false);
  });

  it("rejects when params were altered (replay/forgery)", () => {
    const sig = reference(url, params);
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        signature: sig,
        url,
        params: { ...params, From: "+19998887777" },
      }),
    ).toBe(false);
  });

  it("fails closed when the auth token is missing (not configured)", () => {
    const sig = reference(url, params);
    expect(
      validateTwilioSignature({ authToken: "", signature: sig, url, params }),
    ).toBe(false);
    expect(
      validateTwilioSignature({
        authToken: undefined,
        signature: sig,
        url,
        params,
      }),
    ).toBe(false);
  });

  it("fails closed when the signature header is absent", () => {
    expect(
      validateTwilioSignature({ authToken: AUTH_TOKEN, signature: null, url, params }),
    ).toBe(false);
  });
});
