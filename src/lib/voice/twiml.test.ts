import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import {
  gatherTwiML,
  hangupTwiML,
  sayThenHangupTwiML,
  dialThenHangupTwiML,
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

  it("emits a <Play> of the absolute TTS URL and NO duplicate <Say>", () => {
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
    // CRITICAL: no <Say> alongside the <Play> — emitting both made Twilio voice
    // the line twice (MP3 + Polly). ElevenLabs mode is <Play> only.
    expect(xml).not.toContain("<Say");
  });

  it("emits nothing after the <Gather> (silence submits to the action instead)", () => {
    const xml = gatherTwiML({
      say: "Go ahead.",
      action: "/x",
      voice: ELEVEN_VOICE,
    });
    expect((xml.match(/<Play>/g) ?? []).length).toBe(1);
    expect(xml).not.toContain("<Say");
    expect(xml.trim()).toMatch(/<\/Gather>\s*<\/Response>$/);
  });

  it("plays the final line then hangs up (no duplicate <Say>)", () => {
    const xml = sayThenHangupTwiML("Goodbye now.", ELEVEN_VOICE);
    expect(xml).toContain("<Play>");
    expect(xml).not.toContain("<Say");
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

  it("defaults to a natural 1s speechTimeout (snappier than auto), env-overridable", () => {
    delete process.env.TWILIO_SPEECH_TIMEOUT;
    expect(gatherTwiML({ say: "Hi.", action: "/x" })).toContain(
      'speechTimeout="1"',
    );
    process.env.TWILIO_SPEECH_TIMEOUT = "auto";
    expect(gatherTwiML({ say: "Hi.", action: "/x" })).toContain(
      'speechTimeout="auto"',
    );
    process.env.TWILIO_SPEECH_TIMEOUT = "3";
    expect(gatherTwiML({ say: "Hi.", action: "/x" })).toContain(
      'speechTimeout="3"',
    );
    delete process.env.TWILIO_SPEECH_TIMEOUT;
  });

  it("XML-escapes the spoken text to keep the document well-formed", () => {
    const xml = gatherTwiML({
      say: 'Tom & "Jerry" <fixed> it',
      action: "/x",
    });
    expect(xml).toContain("Tom &amp; &quot;Jerry&quot; &lt;fixed&gt; it");
    expect(xml).not.toContain("<fixed>");
  });

  it("submits to the action even when the caller stays silent (actionOnEmptyResult)", () => {
    // Without this attribute Twilio falls through the <Gather> on silence and,
    // with nothing after it, hangs up on the caller mid-intake. With it, the
    // gather route receives an empty SpeechResult and can re-prompt gracefully.
    const xml = gatherTwiML({
      say: "Go ahead.",
      action: "/api/voice/gather",
    });
    expect(xml).toContain('actionOnEmptyResult="true"');
  });
});

describe("gatherTwiML DTMF", () => {
  it("renders <Gather input='dtmf speech' numDigits='5'> when those params are passed", () => {
    const xml = gatherTwiML({
      say: "Please enter your 5-digit ZIP code.",
      action: "/api/voice/gather",
      input: "dtmf speech",
      numDigits: 5,
    });
    expect(xml).toContain('input="dtmf speech"');
    expect(xml).toContain('numDigits="5"');
    expect(xml).not.toContain("finishOnKey");
  });

  it("defaults to speech-only input when no input param is given", () => {
    const xml = gatherTwiML({ say: "Hello.", action: "/x" });
    expect(xml).toContain('input="speech"');
    expect(xml).not.toContain("dtmf");
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

describe("dialThenHangupTwiML (Stage 2 warm transfer)", () => {
  it("emits a hand-off line then a <Dial> with a status-callback action (no inline fallback)", () => {
    const xml = dialThenHangupTwiML({
      say: "Connecting you to a team member.",
      number: "+15551234567",
      fallback: "No one is available; we'll call you back.",
    });
    expect(xml).toContain("<Dial");
    expect(xml).toContain("+15551234567");
    expect(xml).toContain("Connecting you");
    // The fallback is NOT inline — it's deferred to the dial-status action so it
    // only plays on a FAILED dial, never after a successful transfer (audit #38).
    expect(xml).not.toContain("call you back");
    // The fallback rides in the action query (url-encoded, then XML-escaped).
    expect(xml).toContain("/api/voice/dial-status?fallback=");
    expect(xml).toContain(encodeURIComponent("No one is available"));
    // Order: say -> dial.
    expect(xml.indexOf("Connecting you")).toBeLessThan(xml.indexOf("<Dial"));
  });

  it("XML-escapes the dialed number", () => {
    const xml = dialThenHangupTwiML({
      say: "x",
      number: "+1<bad>",
      fallback: "y",
    });
    expect(xml).not.toContain("<bad>");
    expect(xml).toContain("&lt;bad&gt;");
  });
});
