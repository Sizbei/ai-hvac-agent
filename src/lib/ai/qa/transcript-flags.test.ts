import { describe, it, expect } from "vitest";
import { assessTranscriptFlags } from "./transcript-flags";
import type { ConversationMessage } from "./transcript-adapter";

const clean: ConversationMessage[] = [
  { role: "assistant", content: "Hi, thanks for calling Spears Services!" },
  { role: "user", content: "my AC stopped working" },
  { role: "assistant", content: "Sorry to hear that — I can get a technician out to you. Want me to set that up?" },
];

describe("assessTranscriptFlags", () => {
  it("flags a greeting and a booking attempt on a clean call, no violations", () => {
    const f = assessTranscriptFlags(clean);
    expect(f.greetingGiven).toBe(true);
    expect(f.bookingAttempted).toBe(true);
    expect(f.priceQuoted).toBe(false);
    expect(f.falseBooking).toBe(false);
    expect(f.dangerousDiy).toBe(false);
    expect(f.credentialClaim).toBe(false);
  });

  it("flags a price quote ($ and spoken forms)", () => {
    expect(
      assessTranscriptFlags([{ role: "assistant", content: "That'll be $200." }]).priceQuoted,
    ).toBe(true);
    expect(
      assessTranscriptFlags([{ role: "assistant", content: "about two hundred dollars" }]).priceQuoted,
    ).toBe(true);
  });

  it("flags a false booking claim", () => {
    const f = assessTranscriptFlags([
      { role: "assistant", content: "Great, you're all booked for Tuesday!" },
    ]);
    expect(f.falseBooking).toBe(true);
  });

  it("flags dangerous DIY and credential claims", () => {
    expect(
      assessTranscriptFlags([{ role: "assistant", content: "Here's how to recharge your refrigerant yourself." }])
        .dangerousDiy,
    ).toBe(true);
    expect(
      assessTranscriptFlags([{ role: "assistant", content: "I'm a licensed technician, trust me." }])
        .credentialClaim,
    ).toBe(true);
  });

  it("greetingGiven is false when the first agent turn has no greeting", () => {
    const f = assessTranscriptFlags([
      { role: "assistant", content: "What is the issue with your system?" },
    ]);
    expect(f.greetingGiven).toBe(false);
  });

  it("only inspects agent turns (a customer saying a price is not a violation)", () => {
    const f = assessTranscriptFlags([
      { role: "user", content: "the last guy charged me $500 and said you're all booked" },
      { role: "assistant", content: "I understand — let me help." },
    ]);
    expect(f.priceQuoted).toBe(false);
    expect(f.falseBooking).toBe(false);
  });

  it("handles an empty transcript (all false)", () => {
    expect(assessTranscriptFlags([])).toEqual({
      greetingGiven: false,
      bookingAttempted: false,
      priceQuoted: false,
      falseBooking: false,
      dangerousDiy: false,
      credentialClaim: false,
    });
  });
});
