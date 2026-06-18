import { describe, it, expect } from "vitest";
import {
  PHONE_SYSTEM_PROMPT,
  selectSystemPrompt,
  voiceNextSlotPrompt,
  toSpokenReply,
} from "./phone-agent";
import { SYSTEM_PROMPT } from "./system-prompt";

describe("selectSystemPrompt", () => {
  it("returns the phone persona for the phone channel", () => {
    expect(selectSystemPrompt("phone")).toBe(PHONE_SYSTEM_PROMPT);
  });

  it("returns the web persona for the web channel (and default)", () => {
    expect(selectSystemPrompt("web")).toBe(SYSTEM_PROMPT);
  });

  it("uses the web (text) persona for SMS, not the spoken phone one", () => {
    // SMS is written text the customer can read, so the voice-only persona
    // ("read details back", "can't see a screen") doesn't apply.
    expect(selectSystemPrompt("sms")).toBe(SYSTEM_PROMPT);
  });
});

describe("PHONE_SYSTEM_PROMPT", () => {
  it("instructs a voice-appropriate style (spoken, no UI affordances)", () => {
    const p = PHONE_SYSTEM_PROMPT.toLowerCase();
    expect(p).toContain("phone");
    // Must not reference visual/tap affordances that make no sense on a call.
    expect(p).not.toContain("tap");
    expect(p).not.toContain("button");
    // Note: "type" legitimately appears in the shared HVAC knowledge block
    // ("refrigerant type") — the important guard is "tap" and "button".
  });

  it("asks the model to spell back contact details", () => {
    expect(PHONE_SYSTEM_PROMPT.toLowerCase()).toContain("repeat");
  });
});

describe("toSpokenReply", () => {
  it("strips markdown emphasis and the 'tap a button' escalation affordance", () => {
    const spoken = toSpokenReply(
      "**Got it!** I can help.\n\nIf you'd prefer to speak with a human, you can tap “Talk to a Human” anytime.",
    );
    expect(spoken).not.toContain("**");
    expect(spoken.toLowerCase()).not.toContain("tap");
    expect(spoken).toContain("Got it!");
  });

  it("collapses newlines into spoken pauses (single spaces)", () => {
    const spoken = toSpokenReply("Line one.\n\nLine two.");
    expect(spoken).toBe("Line one. Line two.");
  });

  it("offers a spoken human-transfer instead of a button when near the limit", () => {
    const spoken = toSpokenReply(
      "Thanks.",
      { nearLimit: true },
    );
    expect(spoken.toLowerCase()).toContain("stay on the line");
    expect(spoken.toLowerCase()).not.toContain("tap");
  });
});

describe("voiceNextSlotPrompt (triage-driven)", () => {
  // Note: the safety screen on voice is enforced by the router's emergency
  // escalation (a hazard short-circuits the call), so voiceNextSlotPrompt — which
  // runs AFTER the turn is processed — begins at the qualifying questions.
  it("starts with a qualifying question (system down status)", () => {
    expect(voiceNextSlotPrompt({}).toLowerCase()).toMatch(/completely down|partly working/);
  });
  it("asks how long it's been happening after the down-status is known", () => {
    const next = voiceNextSlotPrompt({
      extras: { systemDownStatus: "fully_down" },
    }).toLowerCase();
    expect(next).toContain("how long");
  });
  it("asks for the address once qualifying questions are answered", () => {
    expect(
      voiceNextSlotPrompt({
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }).toLowerCase(),
    ).toContain("address");
  });
  it("asks the city/ZIP follow-up when only a partial street address is known", () => {
    // A bare street (no city/ZIP, no comma) now routes through the address_parts
    // follow-up step before the flow moves on.
    expect(
      voiceNextSlotPrompt({
        address: "5 Oak St",
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }).toLowerCase(),
    ).toContain("city");
  });
  it("asks for urgency once a complete address, phone, name and email are known", () => {
    expect(
      voiceNextSlotPrompt({
        address: "5 Oak St, Seattle, WA 98101",
        phone: "555-1234",
        name: "Jane Doe",
        // voice skips name/email core steps via the sentinel, so urgency is next
        // once the address is complete.
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }).toLowerCase(),
    ).toContain("urgent");
  });
});
