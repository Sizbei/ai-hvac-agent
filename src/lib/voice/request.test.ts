import { describe, it, expect, afterEach } from "vitest";
import { resolveVoiceMode } from "./request";

afterEach(() => {
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.VOICE_PROVIDER;
});

function req(): Request {
  return new Request("https://example.com/api/voice/incoming", {
    method: "POST",
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "phone.example.com",
    },
  });
}

describe("resolveVoiceMode", () => {
  it("defaults to ElevenLabs when a key is set and no VOICE_PROVIDER is given", () => {
    process.env.ELEVENLABS_API_KEY = "sk-test";
    const mode = resolveVoiceMode(req(), 1000);
    expect(mode.kind).toBe("elevenlabs");
    if (mode.kind === "elevenlabs") {
      expect(mode.baseUrl).toBe("https://phone.example.com");
      expect(mode.now).toBe(1000);
    }
  });

  it("forces Polly when VOICE_PROVIDER=polly even though a key is set", () => {
    process.env.ELEVENLABS_API_KEY = "sk-test";
    process.env.VOICE_PROVIDER = "polly";
    expect(resolveVoiceMode(req(), 1000).kind).toBe("polly");
  });

  it("is case-insensitive on the Polly escape hatch", () => {
    process.env.ELEVENLABS_API_KEY = "sk-test";
    process.env.VOICE_PROVIDER = "POLLY";
    expect(resolveVoiceMode(req(), 1000).kind).toBe("polly");
  });

  it("falls back to Polly when no key is configured", () => {
    expect(resolveVoiceMode(req(), 1000).kind).toBe("polly");
  });
});

describe("reconstructWebhookUrl", () => {
  it("preserves the query string — Twilio signs the FULL URL it posted to", async () => {
    const { reconstructWebhookUrl } = await import("./config");
    const req = new Request(
      "http://localhost:3000/api/voice/gather?silence=1",
      { method: "POST" },
    );
    expect(
      reconstructWebhookUrl(req, "https", "app.example.com"),
    ).toBe("https://app.example.com/api/voice/gather?silence=1");
  });

  it("leaves query-less URLs unchanged", async () => {
    const { reconstructWebhookUrl } = await import("./config");
    const req = new Request("http://localhost:3000/api/voice/incoming", {
      method: "POST",
    });
    expect(reconstructWebhookUrl(req, "https", "app.example.com")).toBe(
      "https://app.example.com/api/voice/incoming",
    );
  });
});
