import { describe, it, expect } from "vitest";
import {
  screenAssistantReply,
  PRICE_REGEX,
  FALSE_BOOKING_REGEX,
  DANGEROUS_DIY_REGEX,
  CREDENTIAL_REGEX,
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

describe("screenAssistantReply — dangerous-DIY backstop", () => {
  // --- SHOULD BLOCK (safe: false, violation: "dangerous-diy") ---

  it("blocks refrigerant recharge step-by-step instructions", () => {
    const text =
      "Here's how to recharge your refrigerant: connect the gauge manifold to the low-side port and slowly open the valve.";
    const r = screenAssistantReply(text);
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks pilot relight steps", () => {
    const text =
      "To relight the pilot, turn the gas valve to pilot and hold the igniter button for 30 seconds.";
    const r = screenAssistantReply(text);
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks capacitor discharge instructions", () => {
    const text =
      "Discharge the capacitor with a screwdriver then unscrew it from the bracket.";
    const r = screenAssistantReply(text);
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks high-voltage wiring instructions", () => {
    const text =
      "Here's how to wire the new contactor: connect the L1 and L2 leads to the line terminals.";
    const r = screenAssistantReply(text);
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  // --- SHOULD NOT BLOCK (legitimate general explanations) ---

  it("does NOT flag a general explanation of a capacitor", () => {
    const r = screenAssistantReply(
      "A capacitor helps the motor start — it provides a short burst of extra power to get the fan spinning.",
    );
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });

  it("does NOT flag mentioning low refrigerant as a cause (no how-to)", () => {
    const r = screenAssistantReply(
      "Low refrigerant can cause your coil to ice up — a technician can check it and recharge the system properly.",
    );
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });

  it("does NOT flag safe self-help: air filter replacement", () => {
    const r = screenAssistantReply(
      "Your air filter is easy to replace yourself every couple of months — just slide the old one out and put in the new one.",
    );
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });

  it("does NOT flag a general heat pump explanation", () => {
    const r = screenAssistantReply(
      "A heat pump moves heat rather than generating it — in winter it extracts heat from outside air and brings it indoors.",
    );
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });

  // --- SAFE REPLACEMENT is itself clean ---

  it("dangerous-diy safe replacement passes re-screening (no recursion)", () => {
    const trigger =
      "To recharge your AC, connect the manifold gauges to the service ports and add R-410A until the pressure reads correctly.";
    const once = screenAssistantReply(trigger);
    expect(once.safe).toBe(false);
    expect(once.violations).toContain("dangerous-diy");
    const twice = screenAssistantReply(once.reply);
    expect(twice.safe).toBe(true);
  });
});

describe("screenAssistantReply — fabricated credential backstop", () => {
  // --- SHOULD BLOCK (safe: false, violation: "credentials") ---

  it("blocks 'I'm EPA-certified'", () => {
    const r = screenAssistantReply(
      "Don't worry — I'm EPA-certified so I can walk you through this.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("credentials");
  });

  it("blocks 'I'm a licensed technician'", () => {
    const r = screenAssistantReply(
      "As I'm a licensed technician, I can advise you on this repair.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("credentials");
  });

  it("blocks 'I'm a certified technician'", () => {
    const r = screenAssistantReply("I'm a certified technician with 10 years of experience.");
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("credentials");
  });

  it("blocks 'I'm qualified to do that'", () => {
    const r = screenAssistantReply(
      "I'm qualified to advise you on refrigerant handling.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("credentials");
  });

  it("blocks 'I'm NATE-certified'", () => {
    const r = screenAssistantReply("I'm NATE-certified and can guide you through this.");
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("credentials");
  });

  // --- SAFE REPLACEMENT is itself clean ---

  it("credential safe replacement passes re-screening", () => {
    const once = screenAssistantReply("I'm EPA-certified to advise on refrigerant.");
    expect(once.safe).toBe(false);
    const twice = screenAssistantReply(once.reply);
    expect(twice.safe).toBe(true);
  });
});

describe("DANGEROUS_DIY_REGEX and CREDENTIAL_REGEX exports", () => {
  it("DANGEROUS_DIY_REGEX is exported and is a RegExp", () => {
    expect(DANGEROUS_DIY_REGEX).toBeInstanceOf(RegExp);
  });

  it("CREDENTIAL_REGEX is exported and is a RegExp", () => {
    expect(CREDENTIAL_REGEX).toBeInstanceOf(RegExp);
  });
});
