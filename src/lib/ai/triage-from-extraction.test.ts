import { describe, it, expect } from "vitest";
import {
  extractionToTriageSlots,
  chipsForExtraction,
} from "./triage-from-extraction";
import type { ExtractionResult } from "./extraction-schema";

/** A minimal extraction with everything null/empty (nothing collected yet). */
function emptyExtraction(
  overrides: Partial<ExtractionResult> = {},
): ExtractionResult {
  return {
    issueType: null,
    urgency: null,
    address: null,
    customerName: null,
    customerPhone: null,
    customerEmail: null,
    description: "",
    isHvacRelated: true,
    ...overrides,
  } as ExtractionResult;
}

describe("extractionToTriageSlots", () => {
  it("lifts core fields to top-level triage slots", () => {
    const slots = extractionToTriageSlots(
      emptyExtraction({
        issueType: "heating_not_working",
        urgency: "high",
        address: "120 Broadway, Seattle, WA 98122",
        customerName: "Raymond Chen",
        customerPhone: "6478960801",
      }),
    );
    expect(slots.issueType).toBe("heating_not_working");
    expect(slots.urgency).toBe("high");
    expect(slots.address).toBe("120 Broadway, Seattle, WA 98122");
    expect(slots.name).toBe("Raymond Chen");
    expect(slots.phone).toBe("6478960801");
    expect(slots.safetyScreenPassed).toBe(true);
  });

  it("moves the flat optional intake fields into the extras bag (only when set)", () => {
    const slots = extractionToTriageSlots(
      emptyExtraction({
        systemDownStatus: "fully_down",
        preferredWindow: "morning",
        equipmentBrand: null, // not set → must NOT appear in extras
      }),
    );
    expect(slots.extras.systemDownStatus).toBe("fully_down");
    expect(slots.extras.preferredWindow).toBe("morning");
    expect("equipmentBrand" in slots.extras).toBe(false);
  });

  it("treats empty-string fields as unset", () => {
    const slots = extractionToTriageSlots(
      emptyExtraction({ problemDuration: "" as unknown as string }),
    );
    expect("problemDuration" in slots.extras).toBe(false);
  });
});

describe("chipsForExtraction", () => {
  it("returns [] when there's no extraction", () => {
    expect(chipsForExtraction(null)).toEqual([]);
  });

  it("offers the system-down chips first when the issue is known but qualifying questions aren't answered", () => {
    const chips = chipsForExtraction(
      emptyExtraction({ issueType: "heating_not_working" }),
    );
    const values = chips.map((c) => c.value);
    expect(values).toContain("fully_down");
    expect(values).toContain("partially_working");
  });

  it("offers tappable window chips once required fields and qualifiers are filled", () => {
    const chips = chipsForExtraction(
      emptyExtraction({
        issueType: "heating_not_working",
        urgency: "high",
        address: "120 Broadway, Seattle, WA 98122",
        customerName: "Raymond Chen",
        customerPhone: "6478960801",
        customerEmail: "ray@example.com",
        systemDownStatus: "fully_down",
        problemDuration: "a few days",
      }),
    );
    const values = chips.map((c) => c.value);
    // Next enrichment step that has chips — system_type comes before window, so
    // assert we at least surface tappable choice chips (not free text).
    expect(chips.length).toBeGreaterThan(0);
    expect(values).not.toContain(""); // never an empty/free-text chip
  });

  it("returns [] (intake done → Complete & Submit) once core + system_type + window are filled", () => {
    const chips = chipsForExtraction(
      emptyExtraction({
        issueType: "heating_not_working",
        urgency: "high",
        address: "120 Broadway, Seattle, WA 98122",
        customerName: "Raymond Chen",
        customerPhone: "6478960801",
        customerEmail: "ray@example.com",
        systemDownStatus: "fully_down",
        problemDuration: "a few days",
        systemType: "central_ac",
        preferredWindow: "morning",
      }),
    );
    expect(chips).toEqual([]);
  });

  it("returns [] (no chips) for the address_parts free-text follow-up", () => {
    // Partial address (no comma, not complete) → ADDRESS_PARTS_STEP, free text.
    const chips = chipsForExtraction(
      emptyExtraction({
        issueType: "heating_not_working",
        address: "120 Broadway",
        systemDownStatus: "fully_down",
        problemDuration: "a few days",
      }),
    );
    expect(chips).toEqual([]);
  });

  it("returns [] (no chips) for a free-text step like address", () => {
    // issue + qualifiers known, but address missing → ADDRESS_STEP (free text).
    const chips = chipsForExtraction(
      emptyExtraction({
        issueType: "heating_not_working",
        systemDownStatus: "fully_down",
        problemDuration: "a few days",
      }),
    );
    expect(chips).toEqual([]);
  });
});
