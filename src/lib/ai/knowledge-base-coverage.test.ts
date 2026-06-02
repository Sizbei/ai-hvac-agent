import { describe, it, expect } from "vitest";
import { routeMessage } from "./intent-router";
import { KNOWLEDGE_BASE } from "./knowledge-base";

/**
 * Coverage + routing guard for the expanded FAQ knowledge base (pricing,
 * membership, efficiency, replacement, equipment, service logistics, trust,
 * warranty detail, refrigerant). Each representative phrasing must resolve to
 * the intended intent and action — this catches trigger collisions with the
 * existing issue/emergency intents and regressions if keywords change.
 */

interface Expectation {
  readonly message: string;
  readonly intentId: string;
  readonly action: "ANSWER" | "FALLBACK_LLM";
}

const EXPECTATIONS: readonly Expectation[] = [
  // pricing
  { message: "do you offer free estimates?", intentId: "pricing-free-estimate", action: "ANSWER" },
  { message: "what's your diagnostic fee?", intentId: "pricing-diagnostic-fee", action: "ANSWER" },
  { message: "is the fee waived if I do the repair?", intentId: "pricing-fee-waived", action: "ANSWER" },
  { message: "how much for a new system?", intentId: "pricing-cost-to-replace", action: "FALLBACK_LLM" },
  { message: "do you have a senior discount?", intentId: "pricing-discounts", action: "ANSWER" },
  { message: "can I get a second opinion on another quote?", intentId: "pricing-second-opinion", action: "ANSWER" },
  // membership
  { message: "do you have a maintenance plan?", intentId: "membership-explainer", action: "ANSWER" },
  { message: "is the plan worth it?", intentId: "membership-worth-it", action: "ANSWER" },
  { message: "am I a member?", intentId: "membership-account", action: "FALLBACK_LLM" },
  // efficiency
  { message: "are there rebates for a new system?", intentId: "efficiency-rebates", action: "ANSWER" },
  { message: "is there a tax credit for a new furnace?", intentId: "efficiency-tax-credit", action: "ANSWER" },
  { message: "will a new system lower my energy bill?", intentId: "efficiency-savings", action: "FALLBACK_LLM" },
  // replacement
  { message: "how long does a furnace last?", intentId: "replacement-lifespan", action: "ANSWER" },
  { message: "should I repair or replace my system?", intentId: "replacement-repair-or-replace", action: "FALLBACK_LLM" },
  { message: "what size ac do I need?", intentId: "replacement-sizing", action: "ANSWER" },
  { message: "I want a quote for a new install", intentId: "replacement-consultation", action: "FALLBACK_LLM" },
  // equipment
  { message: "do you install ductless mini-splits?", intentId: "equipment-minisplit", action: "ANSWER" },
  { message: "do you work on boilers?", intentId: "equipment-boiler", action: "FALLBACK_LLM" },
  { message: "do you install UV lights or air purifiers?", intentId: "equipment-iaq-products", action: "ANSWER" },
  // service logistics
  { message: "what time will the tech arrive?", intentId: "logistics-arrival-window", action: "ANSWER" },
  { message: "do I need to be home for the appointment?", intentId: "logistics-be-home", action: "ANSWER" },
  { message: "how should I prepare for the visit?", intentId: "logistics-prepare", action: "ANSWER" },
  { message: "can someone come out today?", intentId: "logistics-same-day-vs-emergency", action: "FALLBACK_LLM" },
  { message: "is there an extra charge for after hours?", intentId: "logistics-after-hours-fee", action: "ANSWER" },
  // trust
  { message: "do you guarantee your work?", intentId: "trust-guarantee", action: "ANSWER" },
  { message: "are your technicians background checked?", intentId: "trust-technicians", action: "ANSWER" },
  // warranty detail
  { message: "is my repair covered under warranty?", intentId: "warranty-coverage-check", action: "FALLBACK_LLM" },
  { message: "how do I register my warranty?", intentId: "warranty-registration", action: "ANSWER" },
  // refrigerant
  { message: "is R-410A being phased out?", intentId: "refrigerant-phaseout", action: "ANSWER" },
  { message: "how much to recharge my ac with freon?", intentId: "refrigerant-recharge", action: "FALLBACK_LLM" },
];

describe("expanded knowledge base — routing", () => {
  for (const { message, intentId, action } of EXPECTATIONS) {
    it(`routes "${message}" -> ${intentId} (${action})`, () => {
      const v = routeMessage(message);
      expect(v.action).toBe(action);
      if (action === "ANSWER") {
        // ANSWER verdicts carry the resolved intent + canned reply.
        expect(v.intentId).toBe(intentId);
        expect(v.reply).toBeTruthy();
      } else {
        // The router deliberately drops the intentId on a FALLBACK_LLM verdict
        // (the LLM takes over). What matters for these intents is that they
        // DON'T get answered with a wrong canned reply — they fall back.
        expect(v.intentId).toBeNull();
        expect(v.reply).toBeNull();
      }
    });
  }
});

describe("knowledge base — integrity", () => {
  it("has no duplicate intent ids", () => {
    const ids = KNOWLEDGE_BASE.map((e) => e.id);
    const seen = new Set<string>();
    const dupes = ids.filter((id) => {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    });
    expect(dupes).toEqual([]);
  });

  it("every ANSWER/REDIRECT entry has a non-empty canned response", () => {
    for (const entry of KNOWLEDGE_BASE) {
      if (entry.action === "ANSWER" || entry.action === "REDIRECT") {
        expect(
          entry.cannedResponse.trim().length,
          `${entry.id} should have a canned response`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("every FALLBACK_LLM entry has an empty canned response", () => {
    for (const entry of KNOWLEDGE_BASE) {
      if (entry.action === "FALLBACK_LLM") {
        expect(
          entry.cannedResponse,
          `${entry.id} (FALLBACK_LLM) should not carry canned text`,
        ).toBe("");
      }
    }
  });

  it("never quotes a hard dollar amount in a canned response (pricing stays per-company)", () => {
    for (const entry of KNOWLEDGE_BASE) {
      // Allow figures like "15-20 years"; flag currency like "$99" or "$1,200".
      expect(
        /\$\s?\d/.test(entry.cannedResponse),
        `${entry.id} canned response should not contain a $ amount`,
      ).toBe(false);
    }
  });
});
