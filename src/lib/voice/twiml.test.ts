import { describe, it, expect } from "vitest";
import { gatherTwiML, hangupTwiML, sayThenHangupTwiML } from "./twiml";

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
    expect(xml).toContain("<Say>What issue are you having?</Say>");
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
    expect(xml).toContain("<Say>Goodbye now.</Say>");
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
