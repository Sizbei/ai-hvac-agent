/**
 * Tests for the shared HVAC knowledge + safety + scope persona block.
 *
 * These tests are written FIRST (TDD) and describe the contract of
 * HVAC_KNOWLEDGE_AND_SAFETY before the implementation exists.
 */
import { describe, it, expect } from "vitest";
import { HVAC_KNOWLEDGE_AND_SAFETY } from "./hvac-knowledge";
import { buildSystemPrompt } from "./system-prompt";
import { PHONE_SYSTEM_PROMPT } from "./phone-agent";

describe("HVAC_KNOWLEDGE_AND_SAFETY block", () => {
  describe("(a) SCOPE BOUNDARY", () => {
    it("contains a scope boundary section that limits the bot to HVAC topics", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/SCOPE BOUNDARY|scope boundary/i);
    });

    it("refuses non-HVAC requests even when wrapped in HVAC framing", () => {
      // Must name or clearly address the HVAC-framed jailbreak pattern
      const block = HVAC_KNOWLEDGE_AND_SAFETY.toLowerCase();
      expect(block).toMatch(/even when|hvac framing|hvac.*expert.*also|as an hvac/i);
    });

    it("instructs an off-scope redirect (quoted phrasing lives in RULES — single source of truth)", () => {
      // The block tells the model to decline + redirect to HVAC; the exact brand
      // redirect line is in buildSystemPrompt's RULES section, so there is only
      // ONE redirect script in the assembled prompt.
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/decline and redirect/i);
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/RULES section/i);
    });

    it("explicitly covers off-HVAC categories (legal/medical/creative/coding)", () => {
      const block = HVAC_KNOWLEDGE_AND_SAFETY.toLowerCase();
      expect(block).toMatch(/legal|medical|creative|writing|coding/);
    });
  });

  describe("(b) ACCURACY DISCIPLINE", () => {
    it("forbids stating a specific refrigerant type or charge amount as fact", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/refrigerant/i);
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/never state|never.*specific/i);
    });

    it("forbids stating specific model or part numbers as fact", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/model.*part number|part number/i);
    });

    it("forbids stating SEER2 or efficiency ratings as fact", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/SEER2|efficiency rating/i);
    });

    it("forbids stating code or regulation citations as fact", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/code.*regulation|regulation.*citation/i);
    });

    it("forbids diagnosing a specific cause for a symptom", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/diagnose|specific cause/i);
    });

    it("instructs deferring diagnosis to a technician", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/technician can confirm|defer.*technician|technician/i);
    });
  });

  describe("(c) DANGEROUS-DIY REFUSAL", () => {
    it("forbids step-by-step instructions for gas lines or pilot relight", () => {
      const block = HVAC_KNOWLEDGE_AND_SAFETY.toLowerCase();
      expect(block).toMatch(/gas line|pilot.*relight|relight.*pilot/);
    });

    it("forbids step-by-step instructions for refrigerant handling (EPA-regulated)", () => {
      const block = HVAC_KNOWLEDGE_AND_SAFETY.toLowerCase();
      expect(block).toMatch(/refrigerant handling|epa-regulated|epa regulated/);
    });

    it("forbids step-by-step instructions for capacitor or high-voltage work", () => {
      const block = HVAC_KNOWLEDGE_AND_SAFETY.toLowerCase();
      expect(block).toMatch(/capacitor|high-voltage|high voltage/);
    });

    it("forbids step-by-step for anything needing a licensed professional", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/licensed/i);
    });

    it("allows explaining the concept at a high level while refusing step-by-step", () => {
      // The block should distinguish explaining from instructing
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/explain.*high level|high level.*explain|concept/i);
    });
  });

  describe("(d) PRUNED SAFE HOMEOWNER HELP", () => {
    it("allows telling a customer to REPLACE (not clean) a dirty filter", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/replace.*filter|filter.*replace/i);
    });

    it("specifies 'replace' NOT 'clean' for the filter", () => {
      // Should say replace, not clean
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/replace.*NOT clean|not clean|replacing.*filter/i);
    });

    it("allows thermostat batteries, mode, and setpoint checks", () => {
      const block = HVAC_KNOWLEDGE_AND_SAFETY.toLowerCase();
      expect(block).toMatch(/thermostat batteries|thermostat.*mode|thermostat.*setpoint/);
    });

    it("allows checking that vents and registers are not blocked", () => {
      const block = HVAC_KNOWLEDGE_AND_SAFETY.toLowerCase();
      expect(block).toMatch(/vents.*register|register.*vent|vents.*blocked/);
    });

    it("allows confirming the system switch is on", () => {
      const block = HVAC_KNOWLEDGE_AND_SAFETY.toLowerCase();
      expect(block).toMatch(/system switch/);
    });

    it("includes the repeated-breaker-trips caveat: STOP and call", () => {
      const block = HVAC_KNOWLEDGE_AND_SAFETY.toLowerCase();
      expect(block).toMatch(/breaker.*repeatedly|repeatedly.*breaker|breaker trips repeatedly/);
      // Must tell them to STOP, not to keep resetting
      expect(block).toMatch(/stop|do not reset|don't reset/);
      expect(block).toMatch(/call|electrical fault/);
    });

    it("does NOT tell homeowners to touch outdoor condenser or open any unit", () => {
      const block = HVAC_KNOWLEDGE_AND_SAFETY.toLowerCase();
      expect(block).not.toMatch(/clean.*condenser|touch.*condenser|open.*unit/);
    });

    it("does NOT tell homeowners to clear the condensate drain", () => {
      const block = HVAC_KNOWLEDGE_AND_SAFETY.toLowerCase();
      expect(block).not.toContain("condensate drain");
    });
  });

  describe("(e) HELPFUL-FIRST + booking policy + guardrails", () => {
    it("instructs answering the question genuinely and completely first", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/answer.*genuinely|helpfully|helpful-first|answer first/i);
    });

    it("offers to book only when there is a real service need", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/real service need|service need|book.*only/i);
    });

    it("keeps the no-price guardrail", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/never quote.*price|no price|never.*price/i);
    });

    it("keeps the no-false-booking guardrail", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/never claim.*booked|never.*confirmed|no false.booking/i);
    });

    it("keeps the no-invented-credentials guardrail", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/invent.*credentials|credentials|certified/i);
    });

    it("specifies the answer shape (T3) and the defer-specifics habit (T4)", () => {
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/2-4 sentences/i);
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(/pure-education/i);
      expect(HVAC_KNOWLEDGE_AND_SAFETY).toMatch(
        /exact spec depends|never guess a number/i,
      );
    });
  });
});

describe("buildSystemPrompt includes HVAC_KNOWLEDGE_AND_SAFETY block", () => {
  it("contains the HVAC knowledge block in the default prompt", () => {
    const prompt = buildSystemPrompt();
    // The block is embedded by interpolation; check a distinctive phrase from it
    expect(prompt).toContain(HVAC_KNOWLEDGE_AND_SAFETY.trim().slice(0, 80));
  });

  it("contains the HVAC knowledge block in a branded prompt", () => {
    const prompt = buildSystemPrompt({ companyName: "Acme Heating" });
    expect(prompt).toContain(HVAC_KNOWLEDGE_AND_SAFETY.trim().slice(0, 80));
  });
});

describe("PHONE_SYSTEM_PROMPT includes HVAC_KNOWLEDGE_AND_SAFETY block", () => {
  it("contains the HVAC knowledge block", () => {
    expect(PHONE_SYSTEM_PROMPT).toContain(
      HVAC_KNOWLEDGE_AND_SAFETY.trim().slice(0, 80),
    );
  });
});

describe("old unsafe bare 'check the breaker' self-check is removed", () => {
  it("buildSystemPrompt no longer contains the old bare 'check the breaker' self-check instruction", () => {
    const prompt = buildSystemPrompt();
    // The old SELF-CHECKS line said: "suggest checking the thermostat batteries, the breaker, and that the filter isn't clogged"
    // This exact phrasing must be gone
    expect(prompt).not.toContain(
      "suggest checking the thermostat batteries, the breaker",
    );
  });

  it("PHONE_SYSTEM_PROMPT does not contain the old bare 'check the breaker' self-check instruction", () => {
    // Phone prompt never had that line, but assert it remains absent
    expect(PHONE_SYSTEM_PROMPT).not.toContain(
      "suggest checking the thermostat batteries, the breaker",
    );
  });
});
