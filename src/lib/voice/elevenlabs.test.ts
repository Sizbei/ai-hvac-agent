import { describe, it, expect, afterEach } from "vitest";
import {
  synthesizeSpeech,
  getElevenLabsConfig,
  isElevenLabsEnabled,
  ElevenLabsError,
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_ELEVENLABS_MODEL_ID,
} from "./elevenlabs";

afterEach(() => {
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_VOICE_ID;
  delete process.env.ELEVENLABS_MODEL_ID;
});

describe("config gating", () => {
  it("is disabled and returns null config when no key is set", () => {
    expect(isElevenLabsEnabled()).toBe(false);
    expect(getElevenLabsConfig()).toBeNull();
  });

  it("defaults to the Brian voice and turbo model when only a key is set", () => {
    process.env.ELEVENLABS_API_KEY = "sk-test";
    expect(isElevenLabsEnabled()).toBe(true);
    expect(getElevenLabsConfig()).toEqual({
      apiKey: "sk-test",
      voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
      modelId: DEFAULT_ELEVENLABS_MODEL_ID,
    });
  });

  it("honors voice/model overrides", () => {
    process.env.ELEVENLABS_API_KEY = "sk-test";
    process.env.ELEVENLABS_VOICE_ID = "custom-voice";
    process.env.ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
    expect(getElevenLabsConfig()).toEqual({
      apiKey: "sk-test",
      voiceId: "custom-voice",
      modelId: "eleven_flash_v2_5",
    });
  });
});

describe("synthesizeSpeech", () => {
  it("throws without an API key", async () => {
    await expect(synthesizeSpeech("hi")).rejects.toBeInstanceOf(ElevenLabsError);
  });

  it("throws on empty text without calling the network", async () => {
    process.env.ELEVENLABS_API_KEY = "sk-test";
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response();
    }) as unknown as typeof fetch;
    await expect(synthesizeSpeech("   ", fetchImpl)).rejects.toBeInstanceOf(
      ElevenLabsError,
    );
    expect(called).toBe(false);
  });

  it("refuses text over the synthesis cap without calling the network", async () => {
    process.env.ELEVENLABS_API_KEY = "sk-test";
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response();
    }) as unknown as typeof fetch;
    await expect(
      synthesizeSpeech("x".repeat(1501), fetchImpl),
    ).rejects.toBeInstanceOf(ElevenLabsError);
    expect(called).toBe(false);
  });

  it("POSTs to the voice endpoint with the key header and returns MP3 bytes", async () => {
    process.env.ELEVENLABS_API_KEY = "sk-test";
    const captured: { url?: string; init?: RequestInit } = {};
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;

    const out = await synthesizeSpeech("Hello there.", fetchImpl);
    expect(new Uint8Array(out)).toEqual(new Uint8Array([1, 2, 3]));

    expect(captured.url).toContain(
      `/text-to-speech/${DEFAULT_ELEVENLABS_VOICE_ID}`,
    );
    expect(captured.url).toContain("output_format=mp3_22050_32");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("sk-test");
    const body = JSON.parse(captured.init?.body as string);
    expect(body.text).toBe("Hello there.");
    expect(body.model_id).toBe(DEFAULT_ELEVENLABS_MODEL_ID);
  });

  it("throws ElevenLabsError carrying the status on a non-2xx", async () => {
    process.env.ELEVENLABS_API_KEY = "sk-test";
    const fetchImpl = (async () =>
      new Response("bad", { status: 401 })) as unknown as typeof fetch;
    await expect(synthesizeSpeech("hi", fetchImpl)).rejects.toMatchObject({
      name: "ElevenLabsError",
      status: 401,
    });
  });

  it("wraps a network failure in ElevenLabsError", async () => {
    process.env.ELEVENLABS_API_KEY = "sk-test";
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(synthesizeSpeech("hi", fetchImpl)).rejects.toBeInstanceOf(
      ElevenLabsError,
    );
  });
});
