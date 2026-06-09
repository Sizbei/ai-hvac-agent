import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import {
  gatherTwiML,
  hangupTwiML,
  sayThenHangupTwiML,
  DEFAULT_VOICE,
  type VoiceMode,
} from "./twiml";

afterEach(() => {
  delete process.env.TWILIO_VOICE;
});

const ELEVEN_VOICE: VoiceMode = {
  kind: "elevenlabs",
  baseUrl: "https://app.example.com",
  now: 1_700_000_000_000,
};

describe("ElevenLabs <Play> mode", () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });
  afterAll(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it("emits a <Play> of the absolute TTS URL plus a <Say> fallback", () => {
    const xml = gatherTwiML({
      say: "Hello there.",
      action: "/api/voice/gather",
      voice: ELEVEN_VOICE,
    });
    expect(xml).toContain(
      "<Play>https://app.example.com/api/voice/tts?",
    );
    // The signed token carries the text + expiry + signature.
    expect(xml).toContain("text=Hello+there.");
    expect(xml).toContain("exp=");
    expect(xml).toContain("sig=");
    // Fallback <Say> remains so a synthesis failure isn't dead air.
    expect(xml).toContain(`<Say voice="${DEFAULT_VOICE}">Hello there.</Say>`);
    // <Play> comes before the fallback <Say>.
    expect(xml.indexOf("<Play>")).toBeLessThan(xml.indexOf("<Say"));
  });

  it("plays both the prompt and the reprompt in ElevenLabs mode", () => {
    const xml = gatherTwiML({
      say: "Go ahead.",
      action: "/x",
      reprompt: "Still there?",
      voice: ELEVEN_VOICE,
    });
    expect((xml.match(/<Play>/g) ?? []).length).toBe(2);
  });

  it("plays the final line then hangs up", () => {
    const xml = sayThenHangupTwiML("Goodbye now.", ELEVEN_VOICE);
    expect(xml).toContain("<Play>");
    expect(xml).toContain("Goodbye now.</Say>");
    expect(xml).toContain("<Hangup/>");
  });

  it("XML-escapes the <Play> URL (ampersands in the query string)", () => {
    const xml = sayThenHangupTwiML("Bye.", ELEVEN_VOICE);
    // The query separators must be &amp; inside the XML attribute-free text node.
    expect(xml).toContain("&amp;exp=");
    expect(xml).not.toMatch(/<Play>[^<]*[^p]&exp=/);
  });
});

describe("neural voice", () => {
  it("DEFAULT_VOICE is an Amazon Polly neural voice", () => {
    expect(DEFAULT_VOICE).toMatch(/^Polly\..+-Neural$/);
  });

  it("speaks with the default neural voice when TWILIO_VOICE is unset", () => {
    const xml = gatherTwiML({ say: "Hello.", action: "/x" });
    expect(xml).toContain(`<Say voice="${DEFAULT_VOICE}">Hello.</Say>`);
  });

  it("honors a TWILIO_VOICE override across all builders", () => {
    process.env.TWILIO_VOICE = "Polly.Matthew-Neural";
    expect(gatherTwiML({ say: "Hi.", action: "/x" })).toContain(
      '<Say voice="Polly.Matthew-Neural">Hi.</Say>',
    );
    expect(sayThenHangupTwiML("Bye.")).toContain(
      '<Say voice="Polly.Matthew-Neural">Bye.</Say>',
    );
  });

  it("applies the voice to the reprompt line too", () => {
    const xml = gatherTwiML({
      say: "Go ahead.",
      action: "/x",
      reprompt: "Still there?",
    });
    expect(xml).toContain(`<Say voice="${DEFAULT_VOICE}">Still there?</Say>`);
  });
});

describe("gatherTwiML", () => {
  it("produces a <Gather input=speech> that posts to the action URL and speaks the prompt", () => {
    const xml = gatherTwiML({
      say: "What issue are you having?",
      action: "/api/voice/gather",
    });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<Response>");
    expect(xml).toContain('input="speech"');
    expect(xml).toContain('action="/api/voice/gather"');
    expect(xml).toContain('method="POST"');
    expect(xml).toContain("What issue are you having?</Say>");
    expect(xml.trim().endsWith("</Response>")).toBe(true);
  });

  it("XML-escapes the spoken text to keep the document well-formed", () => {
    const xml = gatherTwiML({
      say: 'Tom & "Jerry" <fixed> it',
      action: "/x",
    });
    expect(xml).toContain("Tom &amp; &quot;Jerry&quot; &lt;fixed&gt; it");
    expect(xml).not.toContain("<fixed>");
  });

  it("re-prompts with a fallback <Say> if the caller says nothing", () => {
    const xml = gatherTwiML({
      say: "Go ahead.",
      action: "/api/voice/gather",
      reprompt: "Sorry, I did not catch that. Please tell me what is wrong.",
    });
    // The reprompt sits AFTER the Gather (Twilio falls through if no speech).
    const gatherIdx = xml.indexOf("<Gather");
    const repromptIdx = xml.indexOf("did not catch that");
    expect(repromptIdx).toBeGreaterThan(gatherIdx);
  });
});

describe("sayThenHangupTwiML", () => {
  it("says the message then hangs up", () => {
    const xml = sayThenHangupTwiML("Goodbye now.");
    expect(xml).toContain("Goodbye now.</Say>");
    expect(xml).toContain("<Hangup/>");
  });
});

describe("hangupTwiML", () => {
  it("is a bare hangup response", () => {
    const xml = hangupTwiML();
    expect(xml).toContain("<Response>");
    expect(xml).toContain("<Hangup/>");
  });
});
