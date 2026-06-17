import { describe, it, expect } from "vitest";
import {
  screenAssistantReply,
  PRICE_REGEX,
  FALSE_BOOKING_REGEX,
} from "./output-guardrail";

describe("screenAssistantReply", () => {
  it("passes a clean, on-scope reply through unchanged", () => {
    const text =
      "Got it — sounds like your AC isn't cooling. What's the service address?";
    const r = screenAssistantReply(text);
    expect(r.safe).toBe(true);
    expect(r.reply).toBe(text);
    expect(r.violations).toEqual([]);
  });

  it("replaces a reply that quotes a dollar amount (pricing leak)", () => {
    const r = screenAssistantReply("That repair usually runs about $250.");
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("pricing");
    expect(r.reply).not.toMatch(PRICE_REGEX);
    expect(r.reply).not.toMatch(/\$/);
  });

  it("catches a spaced/comma dollar amount", () => {
    const r = screenAssistantReply("The new unit is around $ 1,200 installed.");
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("pricing");
  });

  it("replaces a false 'you're booked' confirmation", () => {
    const r = screenAssistantReply(
      "Great news — you're booked for Tuesday morning!",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("false-booking");
    expect(r.reply).not.toMatch(FALSE_BOOKING_REGEX);
  });

  it("replaces 'your appointment is confirmed'", () => {
    const r = screenAssistantReply("Your appointment is confirmed for 9am.");
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("false-booking");
  });

  it("reports BOTH violations and uses the combined safe reply", () => {
    const r = screenAssistantReply(
      "You're scheduled for tomorrow and it'll be $99.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toEqual(
      expect.arrayContaining(["pricing", "false-booking"]),
    );
    expect(r.reply).not.toMatch(PRICE_REGEX);
    expect(r.reply).not.toMatch(FALSE_BOOKING_REGEX);
  });

  it("does NOT flag offer/commitment-free language (no false positive)", () => {
    // The bot is allowed to OFFER windows — this must pass.
    const text =
      "I can offer Tuesday morning or Wednesday afternoon — which works better? I'll have our team confirm with you.";
    const r = screenAssistantReply(text);
    expect(r.safe).toBe(true);
    expect(r.reply).toBe(text);
  });

  it("does NOT flag the word 'free' or non-dollar numbers", () => {
    const r = screenAssistantReply(
      "Next-business-day service has no after-hours charge, and we have 2 slots open.",
    );
    expect(r.safe).toBe(true);
  });

  it("the safe replacements are themselves clean (no recursion needed)", () => {
    for (const trigger of [
      "It's $300.",
      "You're booked!",
      "You're scheduled and it's $50.",
    ]) {
      const once = screenAssistantReply(trigger);
      const twice = screenAssistantReply(once.reply);
      expect(twice.safe).toBe(true);
      expect(twice.reply).toBe(once.reply);
    }
  });
});
