import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildChatGreeting,
  buildWelcomeMessage,
  brandInfoFromConfig,
  SYSTEM_PROMPT,
  EXTRACTION_INSTRUCTION,
  type BrandInfo,
} from "./system-prompt";

/** The verified Spears facts the brand prompt must carry, and the unverified
 * claims it must NEVER assert. */
const SPEARS: BrandInfo = {
  companyName: "Spears Services, Inc.",
  phone: "423-854-9505",
  serviceArea:
    "Northeast Tennessee, Southwest Virginia, and Western North Carolina",
  positioning: "the Tri-Cities commercial repair experts",
  serviceScope:
    "commercial HVAC, refrigeration, ice machines, boilers, and commercial appliance repair",
  voiceCues:
    "Sound like an expert focused on uptime — we get your operation back up and running.",
};

/** Phrases that would constitute a POSITIVE assertion of an unverified claim.
 * Note: the prompt legitimately contains a NEGATIVE guardrail line ("NEVER
 * claim certifications (e.g. NATE/EPA), family ownership, financing,
 * warranties...") — that sentence is stripped before this check, since it
 * forbids exactly these claims rather than making them. */
const FORBIDDEN_CLAIMS = [
  "nate-certified",
  "nate certified",
  "epa certified",
  "we are family-owned",
  "family-owned and operated",
  "financing available",
  "we offer financing",
  "backed by our warranty",
  "authorized dealer",
];

/** Remove the explicit prohibition sentence so the forbidden-claim scan only
 * sees the rest of the prompt (where a leaked positive claim would live). */
function stripGuardrailSentence(prompt: string): string {
  return prompt.replace(/NEVER claim certifications[^\n]*\n/, "\n");
}

describe("buildSystemPrompt — default (no brand)", () => {
  it("returns the generic HVAC persona unchanged via SYSTEM_PROMPT", () => {
    expect(SYSTEM_PROMPT).toBe(buildSystemPrompt());
  });

  it("keeps the generic scope and greeting when no brand is passed", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("heating, cooling, and air quality");
    expect(prompt).toContain(
      "Hi, I'm here to help get your heating, cooling, and air quality sorted",
    );
    // No IDENTITY preamble when there's nothing brand-specific to say.
    expect(prompt).not.toContain("IDENTITY:");
  });

  it("retains the core intake gate, safety-first rule, and HVAC knowledge block", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("REQUIRED before submitting");
    expect(prompt).toContain("SAFETY FIRST");
    // SELF-CHECKS replaced by the shared HVAC_KNOWLEDGE_AND_SAFETY block's safe-help section.
    expect(prompt).toContain("SAFE HOMEOWNER HELP");
    // Guard against silently dropping the shared knowledge/safety/scope block.
    expect(prompt).toContain("SCOPE BOUNDARY");
    expect(prompt).toContain("DANGEROUS-DIY REFUSAL");
    expect(prompt).toMatch(/^\/no_think/);
  });

  it("treats the safety screen as a hard gate that comes FIRST, before any field or booking", () => {
    const prompt = buildSystemPrompt();
    // A dedicated, high-priority safety section exists (not just a numbered list item).
    expect(prompt).toContain("SAFETY GATE");
    expect(prompt).toContain("HIGHEST PRIORITY");
    // The gate must precede the required-fields gate in the prompt text.
    expect(prompt.indexOf("SAFETY GATE")).toBeLessThan(
      prompt.indexOf("REQUIRED before submitting"),
    );
    // Explicitly framed as first / before booking, and NOT a closing checkbox.
    expect(prompt).toContain("before any intake field");
    expect(prompt).toContain("NOT a closing checkbox");
  });

  it("short-circuits the whole flow on an active hazard with evacuate + connect-to-human guidance", () => {
    const prompt = buildSystemPrompt();
    // Enumerates the hazards.
    expect(prompt).toMatch(/gas/i);
    expect(prompt).toMatch(/burning or electrical smell/i);
    expect(prompt).toMatch(/carbon-monoxide alarm|CO symptoms/i);
    expect(prompt).toMatch(/active water flooding/i);
    // Immediately stops everything else — no more intake, no booking, no scheduling/charges.
    expect(prompt).toMatch(/IMMEDIATELY STOP|STOP all intake/);
    expect(prompt).toContain("do NOT book");
    expect(prompt).toMatch(/do NOT discuss scheduling or charges/);
    // Evacuate guidance for gas/CO: leave, no switches/flames, call gas company or 911.
    expect(prompt).toContain("leave the building");
    expect(prompt).toMatch(/do NOT touch light switches/);
    expect(prompt).toMatch(/gas company or 911/);
    // Connect to a live person right away.
    expect(prompt).toMatch(/connecting them to a live person/);
  });

  it("forbids re-asking the safety question — at most once, never as a wrap-up", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("AT MOST ONCE");
    expect(prompt).toMatch(/NEVER ask it again|never ask again/);
    // Specifically forbidden as a closing/wrap-up question after booking.
    expect(prompt).toMatch(/wrap-up/);
    expect(prompt).toMatch(/after booking|after an appointment is booked/);
    // The closing confirmation must not append the hazard question.
    expect(prompt).toMatch(/NEVER append the safety hazard question/);
  });

  it("keeps the vulnerable-occupants question as enrichment, NOT a hazard gate", () => {
    const prompt = buildSystemPrompt();
    // It is explicitly called out as separate from / not a safety hazard.
    expect(prompt).toMatch(/SEPARATE enrichment|prioritization detail/);
    expect(prompt).toMatch(/NOT a safety hazard|It is NOT a safety hazard/);
    // And must not be bundled into a closing safety checkbox.
    expect(prompt).toMatch(/never (be )?bundled into|never as a closing safety checkbox/i);
  });

  it("enforces calm-dispatcher tone: empathy once, no script narration, plain prose, confirm once", () => {
    const prompt = buildSystemPrompt();
    // Empathy once, never repeated.
    expect(prompt).toContain("ONCE");
    expect(prompt).toContain("NEVER repeat empathy");
    // No script narration of the upcoming steps.
    expect(prompt).toContain("NEVER narrate your own steps");
    // Plain prose: no markdown / bold / emoji / checkmarks instructed.
    expect(prompt).toContain("NO markdown");
    expect(prompt).toContain("NO emoji");
    expect(prompt).toMatch(/NO bold|asterisks/);
    // The prompt itself must not contain markdown bullets, bold, emoji, or checkmarks.
    expect(prompt).not.toContain("✅");
    expect(prompt).not.toMatch(/\*\*/);
    expect(prompt).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    // Confirm exactly once at the end, not a per-turn re-summary.
    expect(prompt).toContain("Confirm EXACTLY ONCE");
    expect(prompt).toContain("do NOT re-summarize");
  });

  it("empty-string and whitespace-only brand fields fall back to generic", () => {
    const prompt = buildSystemPrompt({
      companyName: "   ",
      phone: "",
      serviceArea: null,
    });
    expect(prompt).toBe(SYSTEM_PROMPT);
  });
});

describe("buildSystemPrompt — Spears brand", () => {
  const prompt = buildSystemPrompt(SPEARS);

  it("identifies as the company by name", () => {
    expect(prompt).toContain("Spears Services, Inc.");
    expect(prompt).toContain("IDENTITY:");
    // Greeting references the company, not the generic line.
    expect(prompt).toContain("thanks for reaching out to Spears Services, Inc.");
  });

  it("includes the verified phone and service area", () => {
    expect(prompt).toContain("423-854-9505");
    expect(prompt).toContain("Northeast Tennessee");
  });

  it("carries the positioning and voice cues", () => {
    expect(prompt).toContain("the Tri-Cities commercial repair experts");
    expect(prompt).toContain("get your operation back up and running");
  });

  it("widens the out-of-scope redirect to the configured services", () => {
    expect(prompt).toContain(
      "I specialize in commercial HVAC, refrigeration, ice machines, boilers, and commercial appliance repair",
    );
    // The old HVAC-only redirect phrasing is gone for a scoped brand.
    expect(prompt).not.toContain(
      "I specialize in heating, cooling, and air quality.",
    );
  });

  it("instructs the model to speak AS the company", () => {
    expect(prompt).toContain("Speak AS this company");
  });

  it("NEVER asserts any unverified credential", () => {
    const body = stripGuardrailSentence(prompt).toLowerCase();
    for (const claim of FORBIDDEN_CLAIMS) {
      expect(body).not.toContain(claim.toLowerCase());
    }
  });

  it("explicitly forbids inventing credentials", () => {
    expect(prompt).toContain("NEVER claim certifications");
  });
});

describe("buildSystemPrompt — partial brand", () => {
  it("brands with name only and keeps the generic scope", () => {
    const prompt = buildSystemPrompt({ companyName: "Acme Heating" });
    expect(prompt).toContain("Acme Heating");
    expect(prompt).toContain("thanks for reaching out to Acme Heating");
    // No serviceScope → generic redirect scope retained.
    expect(prompt).toContain(
      "I specialize in heating, cooling, and air quality.",
    );
    // No serviceArea → no "We serve" line.
    expect(prompt).not.toContain("We serve");
  });

  it("includes phone when set even without a company name", () => {
    const prompt = buildSystemPrompt({ phone: "555-123-4567" });
    expect(prompt).toContain("IDENTITY:");
    expect(prompt).toContain("555-123-4567");
    // No company name → generic greeting.
    expect(prompt).toContain(
      "Hi, I'm here to help get your heating, cooling, and air quality sorted",
    );
  });
});

describe("buildChatGreeting / buildWelcomeMessage", () => {
  it("brands the greeting with the company name when known", () => {
    expect(buildChatGreeting({ companyName: "Acme Heating" })).toBe(
      "Hi, thanks for reaching out to Acme Heating. I'm here to get your issue sorted and a technician on the way.",
    );
  });

  it("falls back to the scope when no company name is set", () => {
    expect(buildChatGreeting({})).toBe(
      "Hi, I'm here to help get your heating, cooling, and air quality sorted and a technician on the way.",
    );
  });

  it("the system prompt's first-greeting instruction uses the SAME copy, so the persisted welcome suppresses a second greeting", () => {
    const brand: BrandInfo = { companyName: "Acme Heating" };
    expect(buildSystemPrompt(brand)).toContain(buildChatGreeting(brand));
  });

  it("the welcome message is the greeting plus the open-ended ask", () => {
    const brand: BrandInfo = { companyName: "Acme Heating" };
    expect(buildWelcomeMessage(brand)).toBe(
      `${buildChatGreeting(brand)} Tell me what's going on, and I'll take care of the rest.`,
    );
  });
});

describe("brandInfoFromConfig", () => {
  it("maps set fields and drops blank/non-string values", () => {
    const info = brandInfoFromConfig("Acme Heating", {
      phone: " 555-123-4567 ",
      serviceArea: "",
      positioning: 42,
      serviceScope: "heating and cooling",
    });
    expect(info.companyName).toBe("Acme Heating");
    expect(info.phone).toBe("555-123-4567");
    expect(info.serviceArea).toBeUndefined();
    expect(info.positioning).toBeUndefined();
    expect(info.serviceScope).toBe("heating and cooling");
  });

  it("yields an empty BrandInfo for an unconfigured org (generic persona)", () => {
    const info = brandInfoFromConfig(null, {});
    expect(info.companyName).toBeUndefined();
    expect(buildSystemPrompt(info)).toBe(SYSTEM_PROMPT);
  });
});

describe("EXTRACTION_INSTRUCTION", () => {
  it("is unchanged and still drives slot extraction", () => {
    expect(EXTRACTION_INSTRUCTION).toContain("extract the following information");
    expect(EXTRACTION_INSTRUCTION).toContain("isHvacRelated");
  });
});
