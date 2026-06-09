import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTtsToken } from "@/lib/voice/tts-token";

vi.mock("server-only", () => ({}));

const { synthSpy } = vi.hoisted(() => ({ synthSpy: vi.fn() }));

vi.mock("@/lib/voice/elevenlabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice/elevenlabs")>();
  return {
    ...actual,
    isElevenLabsEnabled: () => (process.env.ELEVENLABS_API_KEY ?? "").length > 0,
    synthesizeSpeech: synthSpy,
  };
});

import { GET } from "@/app/api/voice/tts/route";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { NextRequest } from "next/server";

const KEY = "a".repeat(64);

function makeRequest(query: string): NextRequest {
  return new NextRequest(`https://app.example.com/api/voice/tts?${query}`);
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY;
  process.env.ELEVENLABS_API_KEY = "sk-test";
  synthSpy.mockReset();
  resetRateLimitStore();
});
afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.ELEVENLABS_API_KEY;
});

function tokenQuery(text: string): string {
  const t = createTtsToken(text, Date.now());
  const p = new URLSearchParams({
    text: t.text,
    exp: String(t.expiresAt),
    sig: t.sig,
  });
  return p.toString();
}

describe("/api/voice/tts", () => {
  it("404s when ElevenLabs is not configured", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const res = await GET(makeRequest(tokenQuery("hi")));
    expect(res.status).toBe(404);
    expect(synthSpy).not.toHaveBeenCalled();
  });

  it("403s on a missing/invalid token without synthesizing", async () => {
    const res = await GET(makeRequest("text=hi&exp=123&sig=bad"));
    expect(res.status).toBe(403);
    expect(synthSpy).not.toHaveBeenCalled();
  });

  it("synthesizes and streams MP3 for a valid token", async () => {
    synthSpy.mockResolvedValue(new Uint8Array([9, 9, 9]).buffer);
    const res = await GET(makeRequest(tokenQuery("Hello caller.")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(synthSpy).toHaveBeenCalledWith("Hello caller.");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([9, 9, 9]),
    );
  });

  it("502s (so Twilio falls back to <Say>) when synthesis throws", async () => {
    synthSpy.mockRejectedValue(new Error("upstream 500"));
    const res = await GET(makeRequest(tokenQuery("Hello.")));
    expect(res.status).toBe(502);
  });

  it("429s after the per-IP burst cap is exceeded", async () => {
    synthSpy.mockResolvedValue(new Uint8Array([1]).buffer);
    const headers = { "x-forwarded-for": "5.5.5.5" };
    let last = 200;
    // Cap is 30/min; the 31st within the window should be throttled.
    for (let i = 0; i < 31; i++) {
      const req = new NextRequest(
        `https://app.example.com/api/voice/tts?${tokenQuery("Hi.")}`,
        { headers },
      );
      last = (await GET(req)).status;
    }
    expect(last).toBe(429);
  });
});
