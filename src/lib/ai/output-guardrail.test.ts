import { describe, it, expect } from "vitest";
import {
  screenAssistantReply,
  PRICE_REGEX,
  PRICE_WORD_REGEX,
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

  // REGRESSION (Stage-10 review): "you are booked" / "you're all booked" must
  // be caught too, not just the apostrophe-form "you're booked".
  it.each([
    "Done — you are booked for Tuesday.",
    "Perfect, you're all booked for tomorrow morning.",
    "You are scheduled for a 9am visit.",
  ])("catches the widened false-booking phrasing: %s", (text) => {
    const r = screenAssistantReply(text);
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("false-booking");
    expect(r.reply).not.toMatch(FALSE_BOOKING_REGEX);
  });

  // REVIEW (M-false-booking): the most NATURAL LLM confirmations are perfect /
  // passive tense, which the present-tense regex missed entirely.
  it.each([
    "I've booked you for Tuesday at 9am.",
    "I have scheduled you for tomorrow morning.",
    "We've got you scheduled for Wednesday.",
    "I've reserved your spot for tomorrow.",
    "You've been booked for Wednesday afternoon.",
    "You have been scheduled for a 9am visit.",
    "Your appointment has been confirmed.",
    "Your appointment has been booked for Tuesday.",
    "Your visit has been scheduled.",
    "Your visit is confirmed.",
  ])("catches perfect/passive false-booking claims: %s", (text) => {
    const r = screenAssistantReply(text);
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("false-booking");
    expect(r.reply).not.toMatch(FALSE_BOOKING_REGEX);
  });

  // These OFFER / negation / future forms must NOT trip the widened regex.
  it.each([
    "I can get you booked once I have your details.",
    "Would you like me to book you in for Tuesday?",
    "Once you confirm, our team will schedule the visit.",
    "I haven't reserved a time slot yet.",
    "I'll have our team confirm your appointment with you.",
  ])("does NOT flag offer/negation/future booking language: %s", (text) => {
    const r = screenAssistantReply(text);
    expect(r.safe).toBe(true);
    expect(r.reply).toBe(text);
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

  // REGRESSION (Stage-10 review): how-to framing + "replace THE capacitor" must
  // block. Previously the "to" lookbehind treated "to replace" as pro-framed and
  // the how-to branch only listed "replace a capacitor" (not "the").
  it.each([
    "Here's how to replace the capacitor yourself: first cut the power.",
    "How to replace the capacitor: discharge it, then swap in the new one.",
  ])("blocks how-to 'replace the capacitor' framing: %s", (text) => {
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

// ─── FIX 1: OVER-BLOCK — technician-will sentences must NOT be blocked ────────

describe("screenAssistantReply — FIX 1: technician-framed actions must not block", () => {
  it("does NOT block 'Our technician will recharge your system and verify the charge'", () => {
    const r = screenAssistantReply(
      "Our technician will recharge your system and verify the charge.",
    );
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });

  it("does NOT block 'A licensed tech can recharge your refrigerant properly'", () => {
    const r = screenAssistantReply(
      "A licensed tech can recharge your refrigerant properly.",
    );
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });

  it("does NOT block 'A tech will replace the capacitor'", () => {
    const r = screenAssistantReply("A tech will replace the capacitor.");
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });

  it("does NOT block 'a technician can help recharge the system'", () => {
    const r = screenAssistantReply(
      "Low refrigerant can cause your coil to ice up — a technician can check it and recharge the system properly.",
    );
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });

  // These MUST still block (no technician frame)
  it("STILL blocks 'you can recharge your system yourself'", () => {
    const r = screenAssistantReply("you can recharge your system yourself");
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("STILL blocks 'recharge your AC with the gauges'", () => {
    const r = screenAssistantReply(
      "To cool better, recharge your AC with the gauges.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });
});

// ─── FIX 2: UNDER-BLOCK — new dangerous phrasings must be caught ──────────────

describe("screenAssistantReply — FIX 2: additional dangerous-DIY patterns blocked", () => {
  it("blocks 'top off the Freon with a can and a gauge'", () => {
    const r = screenAssistantReply(
      "Just top off the Freon with a can and a gauge.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks 'top off your refrigerant'", () => {
    const r = screenAssistantReply("You can top off your refrigerant yourself.");
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks 'add a bit of Freon by hooking up the gauges' (intervening word)", () => {
    const r = screenAssistantReply(
      "You can add a bit of Freon by hooking up the gauges.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks 'hook up the manifold gauges and charge it up'", () => {
    const r = screenAssistantReply(
      "hook up the manifold gauges and charge it up",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks 'attach your gauges to the service ports and add 410A'", () => {
    const r = screenAssistantReply(
      "attach your gauges to the service ports and add 410A",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks 'charge it up'", () => {
    const r = screenAssistantReply(
      "Connect the hoses then charge it up.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks 'swap the contactor by disconnecting the wires'", () => {
    const r = screenAssistantReply(
      "swap the contactor by disconnecting the wires",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks 'short the capacitor terminals before you remove it'", () => {
    const r = screenAssistantReply(
      "short the capacitor terminals before you remove it",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks 'pop the capacitor out after shorting the terminals'", () => {
    const r = screenAssistantReply(
      "pop the capacitor out after shorting the terminals",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks 'light the pilot light'", () => {
    const r = screenAssistantReply(
      "To get the pilot going again, light the pilot light.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks 'hold the knob down and light it'", () => {
    const r = screenAssistantReply(
      "To get the pilot going again, hold the knob down and light it.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks 'set the dial to pilot and press the ignition'", () => {
    const r = screenAssistantReply(
      "set the dial to pilot and press the ignition",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  it("blocks 'recharge the system' (no possessive) without tech frame", () => {
    const r = screenAssistantReply("Just recharge the system with the gauges.");
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("dangerous-diy");
  });

  // FIX 1 + FIX 2 combined: "a tech will recharge the system" must NOT block
  it("does NOT block 'a tech will recharge the system'", () => {
    const r = screenAssistantReply(
      "Our tech will recharge the system during the visit.",
    );
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });
});

// ─── FIX 3: CREDENTIAL_REGEX — "I am" uncontracted form ──────────────────────

describe("screenAssistantReply — FIX 3: 'I am' credential form blocked", () => {
  it("blocks 'I am a licensed technician'", () => {
    const r = screenAssistantReply(
      "I am a licensed technician with 10 years of experience.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("credentials");
  });

  it("blocks 'I am EPA-certified'", () => {
    const r = screenAssistantReply(
      "I am EPA-certified so I can walk you through this.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("credentials");
  });

  it("blocks 'I am NATE-certified'", () => {
    const r = screenAssistantReply(
      "I am NATE-certified and can guide you through this.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("credentials");
  });

  it("blocks 'I am qualified to'", () => {
    const r = screenAssistantReply(
      "I am qualified to advise you on refrigerant handling.",
    );
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("credentials");
  });
});

// ─── Preserved false-positive guards must still pass ─────────────────────────

describe("screenAssistantReply — preserved false-positive guards", () => {
  it("does NOT flag 'low refrigerant can cause icing'", () => {
    const r = screenAssistantReply(
      "Low refrigerant can cause icing on the coil.",
    );
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });

  it("does NOT flag 'a capacitor helps the motor start'", () => {
    const r = screenAssistantReply(
      "A capacitor helps the motor start by providing extra power.",
    );
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });

  it("does NOT flag 'your filter is easy to replace yourself'", () => {
    const r = screenAssistantReply(
      "Your air filter is easy to replace yourself every couple of months.",
    );
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });

  it("does NOT flag 'a licensed technician can help'", () => {
    const r = screenAssistantReply(
      "A licensed technician can help with refrigerant issues.",
    );
    expect(r.safe).toBe(true);
    expect(r.violations).not.toContain("dangerous-diy");
  });

  it("SAFE_DIY_REPLY still re-screens clean (no recursion)", () => {
    const trigger =
      "To recharge your AC, connect the manifold gauges to the service ports.";
    const once = screenAssistantReply(trigger);
    expect(once.safe).toBe(false);
    const twice = screenAssistantReply(once.reply);
    expect(twice.safe).toBe(true);
  });
});

describe("PRICE_WORD_REGEX — spoken/written dollar amounts (no $ symbol)", () => {
  it("flags a digit amount with a currency word", () => {
    const r = screenAssistantReply("That usually runs about 200 dollars.");
    expect(r.safe).toBe(false);
    expect(r.violations).toContain("pricing");
    expect(r.reply).not.toMatch(PRICE_WORD_REGEX);
  });

  it("flags a spelled-out amount ('two hundred dollars')", () => {
    const r = screenAssistantReply("It's usually two hundred dollars for that.");
    expect(r.violations).toContain("pricing");
  });

  it("flags 'bucks' and comma-grouped digits", () => {
    expect(screenAssistantReply("about fifty bucks").violations).toContain("pricing");
    expect(screenAssistantReply("around 1,200 dollars installed").violations).toContain("pricing");
  });

  it("does NOT flag numbers unrelated to currency (no false positives)", () => {
    // A number elsewhere + the word 'dollars' far away must not match (contiguity).
    expect(screenAssistantReply("We have ten years of experience and accept dollars.").safe).toBe(true);
    // Times / durations / quantities with no currency word.
    expect(screenAssistantReply("A tech can be there in about three to five business days.").safe).toBe(true);
    expect(screenAssistantReply("Your filter is a 20 by 25 by 1 inch.").safe).toBe(true);
  });
});
