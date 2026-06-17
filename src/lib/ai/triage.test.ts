import { describe, it, expect } from "vitest";
import {
  nextTriageStep,
  applyTriageAnswer,
  isSkip,
  REQUIRED_FOR_SUBMIT,
  UNSKIPPABLE_CORE,
  ENRICHMENT_NEVER_BLOCKS,
  MAX_ADDRESS_REPROMPTS,
  MAX_ENRICHMENT_STEPS,
  selectEnrichmentOrder,
  type TriageStep,
  type TriageSlots,
} from "./triage";

const COMPLETE_ADDRESS = "5 Oak St, Seattle, WA 98101";

function slots(overrides: Partial<TriageSlots> = {}): TriageSlots {
  return {
    issueType: "cooling_not_working",
    urgency: null,
    address: null,
    name: null,
    phone: null,
    email: null,
    safetyScreenPassed: false,
    extras: {},
    ...overrides,
  };
}

describe("nextTriageStep — ordering", () => {
  it("asks the SAFETY SCREEN before anything else, once an issue is known", () => {
    const step = nextTriageStep(slots());
    expect(step?.id).toBe("safety_screen");
    // It must offer a clear no-hazard quick reply and mention gas/burning/CO/water.
    const q = step!.question.toLowerCase();
    expect(q).toMatch(/gas|burning|carbon monoxide|water|smell/);
    expect(step!.quickReplies.length).toBeGreaterThan(0);
  });

  it("asks system-down status after safety passes", () => {
    const step = nextTriageStep(slots({ safetyScreenPassed: true }));
    expect(step?.id).toBe("system_down");
    expect(step!.quickReplies.map((r) => r.value)).toContain("fully_down");
  });

  it("asks for the service address before optional enrichment", () => {
    const step = nextTriageStep(
      slots({
        safetyScreenPassed: true,
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }),
    );
    expect(step?.id).toBe("address");
  });

  it("asks for phone (required) after a COMPLETE address", () => {
    const step = nextTriageStep(
      slots({
        safetyScreenPassed: true,
        address: "5 Oak St, Seattle, WA 98101",
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }),
    );
    expect(step?.id).toBe("phone");
  });

  it("asks for the customer's full name after phone, before urgency", () => {
    const step = nextTriageStep(
      slots({
        safetyScreenPassed: true,
        address: "5 Oak St, Seattle, WA 98101",
        phone: "555-1234",
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }),
    );
    expect(step?.id).toBe("name");
    // Asks for first + last, with no quick replies (free-text), and is required.
    expect(step!.question.toLowerCase()).toMatch(/full name|first and last/);
    expect(step!.quickReplies.length).toBe(0);
    expect(step!.optional).toBe(false);
  });

  it("asks email after name, before urgency", () => {
    const step = nextTriageStep(
      slots({
        safetyScreenPassed: true,
        address: "5 Oak St, Seattle, WA 98101",
        phone: "555-1234",
        name: "Jane Doe",
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }),
    );
    expect(step?.id).toBe("email");
  });

  it("asks urgency only after name and email are known", () => {
    const step = nextTriageStep(
      slots({
        safetyScreenPassed: true,
        address: "5 Oak St, Seattle, WA 98101",
        phone: "555-1234",
        name: "Jane Doe",
        email: "jane@example.com",
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }),
    );
    expect(step?.id).toBe("urgency");
  });

  it("does not re-ask name once it is filled", () => {
    const step = nextTriageStep(
      slots({
        safetyScreenPassed: true,
        address: "5 Oak St, Seattle, WA 98101",
        phone: "555-1234",
        name: "Jane Doe",
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }),
    );
    expect(step?.id).not.toBe("name");
  });

  it("asks system_type (capped enrichment) once required slots are filled", () => {
    const step = nextTriageStep(
      slots({
        issueType: "thermostat_issue", // generic [system_type, window] order
        safetyScreenPassed: true,
        urgency: "high",
        address: "5 Oak St, Seattle, WA 98101",
        name: "Jane Doe",
        phone: "555-1234",
        email: "jane@example.com",
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }),
    );
    // Enrichment is capped to system_type then preferred_window; system_type is first.
    expect(step?.id).toBe("system_type");
    expect(step!.optional).toBe(true);
  });

  it("returns null (ready to confirm) once core + the two capped enrichment steps are answered or skipped", () => {
    const step = nextTriageStep(
      slots({
        issueType: "thermostat_issue", // generic [system_type, window] order
        safetyScreenPassed: true,
        urgency: "high",
        address: "5 Oak St, Seattle, WA 98101",
        name: "Jane Doe",
        phone: "555-1234",
        email: "jane@example.com",
        extras: {
          systemDownStatus: "fully_down",
          problemDuration: "today",
          systemType: "central_ac",
          preferredWindow: "morning",
        },
      }),
    );
    expect(step).toBeNull();
  });

  it("never re-asks a slot that is already filled", () => {
    // address filled but urgency missing — should not ask address again
    const step = nextTriageStep(
      slots({
        safetyScreenPassed: true,
        address: "5 Oak St, Seattle, WA 98101",
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }),
    );
    expect(step?.id).not.toBe("address");
  });
});

describe("isSkip", () => {
  it("recognizes skip / don't know phrasings", () => {
    for (const s of ["skip", "Skip", "i don't know", "dont know", "not sure", "no idea", "n/a"]) {
      expect(isSkip(s)).toBe(true);
    }
  });
  it("does not treat real answers as skip", () => {
    expect(isSkip("Trane")).toBe(false);
    expect(isSkip("central ac")).toBe(false);
  });
});

describe("applyTriageAnswer — optional fields are skippable", () => {
  it("marks an optional enrichment slot as resolved (skipped) so it is not re-asked", () => {
    const before = slots({
      issueType: "thermostat_issue", // generic [system_type, window] order
      safetyScreenPassed: true,
      urgency: "high",
      address: "5 Oak St, Seattle, WA 98101",
      name: "Jane Doe",
      phone: "555-1234",
      email: "jane@example.com",
      extras: { systemDownStatus: "fully_down", problemDuration: "today" },
    });
    const step = nextTriageStep(before)!;
    expect(step.id).toBe("system_type");
    const after = applyTriageAnswer(before, step, "skip");
    // After skipping system_type, the next step must NOT be system_type again.
    const next = nextTriageStep(after);
    expect(next?.id).not.toBe("system_type");
  });

  it("records a real answer into the right extras slot", () => {
    const before = slots({
      issueType: "thermostat_issue", // generic [system_type, window] order
      safetyScreenPassed: true,
      urgency: "high",
      address: "5 Oak St, Seattle, WA 98101",
      name: "Jane Doe",
      phone: "555-1234",
      email: "jane@example.com",
      extras: { systemDownStatus: "fully_down", problemDuration: "today" },
    });
    const step = nextTriageStep(before)!; // system_type
    const after = applyTriageAnswer(before, step, "heat_pump");
    expect(after.extras.systemType).toBe("heat_pump");
  });

  it("safety screen YES (hazard) marks it NOT passed and flags escalation", () => {
    const before = slots();
    const step = nextTriageStep(before)!; // safety_screen
    const after = applyTriageAnswer(before, step, "yes");
    expect(after.safetyScreenPassed).toBe(false);
    expect(after.safetyHazardReported).toBe(true);
  });

  it("safety screen NO (all clear) passes the screen", () => {
    const before = slots();
    const step = nextTriageStep(before)!;
    const after = applyTriageAnswer(before, step, "no");
    expect(after.safetyScreenPassed).toBe(true);
  });
});

describe("REQUIRED_FOR_SUBMIT", () => {
  it("lists the hard gate (safety + issue + urgency + address + name + phone + email)", () => {
    expect(REQUIRED_FOR_SUBMIT).toEqual([
      "safetyScreenPassed",
      "issueType",
      "urgency",
      "address",
      "name",
      "phone",
      "email",
    ]);
  });

  it("includes name and email as required fields", () => {
    expect(REQUIRED_FOR_SUBMIT).toContain("name");
    expect(REQUIRED_FOR_SUBMIT).toContain("email");
  });
});

describe("captureEnrichmentAnswer (review fixes)", () => {
  it("captures a system_down chip value (qualifying question advances deterministically)", async () => {
    const { captureEnrichmentAnswer } = await import("./triage");
    expect(captureEnrichmentAnswer("system_down", "fully_down")).toEqual({
      key: "systemDownStatus",
      value: "fully_down",
    });
  });

  it("captures free-text duration/brand/access answers (non-empty)", async () => {
    const { captureEnrichmentAnswer } = await import("./triage");
    expect(captureEnrichmentAnswer("duration", "since this morning")).toEqual({
      key: "problemDuration",
      value: "since this morning",
    });
    expect(captureEnrichmentAnswer("equipment_brand", "Trane")).toEqual({
      key: "equipmentBrand",
      value: "Trane",
    });
    expect(captureEnrichmentAnswer("access_notes", "gate code 4821")).toEqual({
      key: "accessNotes",
      value: "gate code 4821",
    });
  });

  it("caps free-text at 1000 chars", async () => {
    const { captureEnrichmentAnswer } = await import("./triage");
    const long = "a".repeat(5000);
    const r = captureEnrichmentAnswer("access_notes", long);
    expect((r?.value as string).length).toBe(1000);
  });

  it("records a skip sentinel for an optional step (so it is not re-asked)", async () => {
    const { captureEnrichmentAnswer, SKIP_SENTINEL } = await import("./triage");
    expect(captureEnrichmentAnswer("system_type", "skip")).toEqual({
      key: "systemType",
      value: SKIP_SENTINEL,
    });
    expect(captureEnrichmentAnswer("equipment_brand", "i don't know")).toEqual({
      key: "equipmentBrand",
      value: SKIP_SENTINEL,
    });
  });

  it("does NOT let a required step (system_down/duration) be skipped", async () => {
    const { captureEnrichmentAnswer } = await import("./triage");
    expect(captureEnrichmentAnswer("system_down", "skip")).toBeNull();
  });

  it("fuzzily maps natural system_down phrasing onto the enum value", async () => {
    const { captureEnrichmentAnswer } = await import("./triage");
    expect(captureEnrichmentAnswer("system_down", "my system is dead")).toEqual({
      key: "systemDownStatus",
      value: "fully_down",
    });
    expect(captureEnrichmentAnswer("system_down", "it still kind of runs")).toEqual({
      key: "systemDownStatus",
      value: "partially_working",
    });
    // A few more natural phrasings on both sides of the enum.
    for (const dead of [
      "it's completely dead",
      "won't turn on at all",
      "there's no power to it",
      "totally dead",
    ]) {
      expect(captureEnrichmentAnswer("system_down", dead)?.value).toBe("fully_down");
    }
    for (const partial of [
      "it's sort of working",
      "blows but warm",
      "the fan is weak",
      "it still runs but barely",
    ]) {
      expect(captureEnrichmentAnswer("system_down", partial)?.value).toBe(
        "partially_working",
      );
    }
  });

  it("does not let fuzzy mapping override an exact enum value", async () => {
    const { captureEnrichmentAnswer } = await import("./triage");
    // Exact chip values still capture exactly (and aren't reinterpreted).
    expect(captureEnrichmentAnswer("system_down", "fully_down")).toEqual({
      key: "systemDownStatus",
      value: "fully_down",
    });
    expect(captureEnrichmentAnswer("system_down", "partially_working")).toEqual({
      key: "systemDownStatus",
      value: "partially_working",
    });
    expect(captureEnrichmentAnswer("system_down", "unknown")).toEqual({
      key: "systemDownStatus",
      value: "unknown",
    });
  });

  it("returns null for a system_down answer with no enum or synonym match", async () => {
    const { captureEnrichmentAnswer } = await import("./triage");
    // Unrecognized → null so the caller can fall back to the LLM.
    expect(captureEnrichmentAnswer("system_down", "the weather is nice")).toBeNull();
  });

  it("a skipped step is treated as resolved by nextTriageStep (sentinel in extras)", async () => {
    const { nextTriageStep, SKIP_SENTINEL } = await import("./triage");
    const step = nextTriageStep(
      slots({
        issueType: "thermostat_issue", // generic [system_type, window] order
        safetyScreenPassed: true,
        urgency: "high",
        address: "5 Oak St, Seattle, WA 98101",
        name: "Jane Doe",
        phone: "555-1234",
        email: "jane@example.com",
        extras: {
          systemDownStatus: "fully_down",
          problemDuration: "today",
          systemType: SKIP_SENTINEL, // skipped
        },
      }),
    );
    expect(step?.id).not.toBe("system_type");
  });
});

describe("enrichment cap — only system_type then preferred_window", () => {
  function coreFilled(extras: Record<string, unknown> = {}): TriageSlots {
    return slots({
      safetyScreenPassed: true,
      urgency: "high",
      address: COMPLETE_ADDRESS,
      name: "Jane Doe",
      phone: "555-1234",
      email: "jane@example.com",
      extras: { systemDownStatus: "fully_down", problemDuration: "today", ...extras },
    });
  }

  it("asks system_type first, then preferred_window, then null for a fallback issue", () => {
    // thermostat_issue has no issue-specific qualifier → generic order applies.
    // 1) core filled → system_type
    const s1 = coreFilled();
    s1.issueType = "thermostat_issue";
    expect(nextTriageStep(s1)?.id).toBe("system_type");

    // 2) system_type set → preferred_window (NOT equipment_age/brand/etc.)
    const s2 = coreFilled({ systemType: "central_ac" });
    s2.issueType = "thermostat_issue";
    expect(nextTriageStep(s2)?.id).toBe("preferred_window");

    // 3) both capped steps set → null (route surfaces Complete & Submit)
    const s3 = coreFilled({ systemType: "central_ac", preferredWindow: "morning" });
    s3.issueType = "thermostat_issue";
    expect(nextTriageStep(s3)).toBeNull();
  });

  it("never asks any of the never-block enrichment steps (fallback issue)", () => {
    const neverIds = new Set(ENRICHMENT_NEVER_BLOCKS.map((s) => s.id));
    // Walk the whole flow from a freshly-cleared safety screen, answering each
    // step, and assert we never land on a never-block step. thermostat_issue
    // uses the generic [system_type, window] fallback order.
    let s = coreFilled();
    s.issueType = "thermostat_issue";
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const step = nextTriageStep(s);
      if (!step) break;
      seen.push(step.id);
      expect(neverIds.has(step.id)).toBe(false);
      // Answer the step to advance: chips use first quick-reply value; free-text
      // gets a placeholder.
      const answer = step.quickReplies[0]?.value ?? "morning";
      s = applyTriageAnswer(s, step, answer);
    }
    // Only the two capped enrichment steps should appear after core.
    expect(seen).toEqual(["system_type", "preferred_window"]);
  });

  it("still CAPTURES a volunteered never-block field (e.g. propertyType) without asking it", () => {
    // Customer volunteered commercial property; engine doesn't ask, and a value
    // already in extras is simply respected (no re-ask, no block).
    const s = coreFilled({
      systemType: "central_ac",
      preferredWindow: "morning",
      propertyType: "commercial",
    });
    s.issueType = "thermostat_issue"; // generic [system_type, window] order
    expect(nextTriageStep(s)).toBeNull();
    expect(s.extras.propertyType).toBe("commercial");
  });

  it("SKIPS system_type for non-HVAC-system service lines (commercial appliance)", () => {
    // A downed commercial oven/range is a valid Spears service line, but the
    // forced-air "Central AC / Furnace / Heat pump…" taxonomy doesn't describe
    // it — asking would store a misleading systemType like "furnace". The engine
    // must jump straight to preferred_window and never ask system_type.
    const s1 = coreFilled();
    s1.issueType = "commercial_appliance";
    expect(nextTriageStep(s1)?.id).toBe("preferred_window");

    // The whole flow from core onward yields ONLY preferred_window.
    let s = coreFilled();
    s.issueType = "commercial_appliance";
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const step = nextTriageStep(s);
      if (!step) break;
      seen.push(step.id);
      s = applyTriageAnswer(s, step, step.quickReplies[0]?.value ?? "morning");
    }
    expect(seen).toEqual(["preferred_window"]);
  });

  it("STILL asks system_type for a generic-order HVAC issue (not suppressed)", () => {
    // Sanity guard: the suppression is scoped to the three non-HVAC service
    // lines, so a normal generic-order issue still gets the system_type question.
    const s = coreFilled();
    s.issueType = "air_quality";
    expect(nextTriageStep(s)?.id).toBe("system_type");
  });

  it("SKIPS system_type for refrigeration and ice_machine too", () => {
    for (const issueType of ["refrigeration", "ice_machine"]) {
      const s = coreFilled();
      s.issueType = issueType;
      expect(nextTriageStep(s)?.id).toBe("preferred_window");
    }
  });
});

describe("partial address → single city/ZIP follow-up", () => {
  function base(address: string | null): TriageSlots {
    return slots({
      safetyScreenPassed: true,
      address,
      extras: { systemDownStatus: "fully_down", problemDuration: "today" },
    });
  }

  it("asks address_parts when the address is partial (no comma, not complete)", () => {
    const step = nextTriageStep(base("120 Broadway"));
    expect(step?.id).toBe("address_parts");
    expect(step!.quickReplies.length).toBe(0); // free text
    expect(step!.optional).toBe(false);
    expect(step!.question.toLowerCase()).toMatch(/city|zip/);
  });

  it("ACCEPTS a complete intl address without a US ZIP (de-US-centered, Step 14)", () => {
    // A valid Canadian address has a street number + street type + city/region
    // but no 5-digit US ZIP. The loosened heuristic accepts it (street component
    // + locality) instead of trapping the customer in a US-ZIP re-prompt loop.
    const step = nextTriageStep(base("123 Main St, Toronto, ON M5V 2T6"));
    expect(step?.id).not.toBe("address_parts");
  });

  it("does NOT ask address_parts when the address is already complete", () => {
    const step = nextTriageStep(base("120 Broadway St Seattle WA 98122"));
    expect(step?.id).not.toBe("address_parts");
  });

  it("applyTriageAnswer on address_parts appends city/ZIP to the street (adds comma)", () => {
    const before = base("120 Broadway");
    const step = nextTriageStep(before)!;
    expect(step.id).toBe("address_parts");
    const after = applyTriageAnswer(before, step, "Seattle, WA 98122");
    expect(after.address).toBe("120 Broadway, Seattle, WA 98122");
    // And the engine no longer re-asks address_parts (comma present).
    expect(nextTriageStep(after)?.id).not.toBe("address_parts");
  });

  it("address_parts append does not mutate the input slots", () => {
    const before = base("120 Broadway");
    const step: TriageStep = nextTriageStep(before)!;
    applyTriageAnswer(before, step, "Seattle, WA 98122");
    expect(before.address).toBe("120 Broadway");
  });
});

describe("address must have a street + locality component OR a verified lookup pick", () => {
  function base(address: string | null, extras: Record<string, unknown> = {}): TriageSlots {
    return slots({
      safetyScreenPassed: true,
      address,
      extras: { systemDownStatus: "fully_down", problemDuration: "today", ...extras },
    });
  }

  it("re-prompts obvious junk with no street component", () => {
    // No street number, no street-type word, no named route → not dispatchable.
    expect(nextTriageStep(base("somewhere downtown"))?.id).toBe("address_parts");
  });

  it("re-prompts a bare city with no street", () => {
    expect(nextTriageStep(base("Toronto"))?.id).toBe("address_parts");
  });

  it("accepts a street line + city even with no street NUMBER (street-type word)", () => {
    // "Main Street, Springfield, IL 62704" has a recognizable street type and a
    // locality — a real, dispatchable line missing only the house number, which
    // the tech can resolve on arrival. Loosened heuristic accepts it.
    expect(
      nextTriageStep(base("Main Street, Springfield, IL 62704"))?.id,
    ).not.toBe("address_parts");
  });

  it("accepts a US address that's missing its ZIP (street number + city)", () => {
    expect(nextTriageStep(base("120 Broadway, New York, NY"))?.id).not.toBe(
      "address_parts",
    );
  });

  it("accepts a complete US address without re-prompting", () => {
    expect(nextTriageStep(base("120 Broadway, New York, NY 10001"))?.id).not.toBe(
      "address_parts",
    );
  });

  it("accepts a verified (lookup-selected) address even if it isn't street-formatted", () => {
    // addressVerified = the customer picked a geocoded suggestion → "found".
    const step = nextTriageStep(
      base("Building near the lake", { addressVerified: "yes" }),
    );
    expect(step?.id).not.toBe("address_parts");
  });

  it("stops re-prompting after MAX_ADDRESS_REPROMPTS to avoid an endless loop", () => {
    const stillBad = "somewhere downtown"; // no street component → keeps re-asking
    // Below the cap → still re-prompting.
    expect(
      nextTriageStep(base(stillBad, { addressAttempts: MAX_ADDRESS_REPROMPTS - 1 }))
        ?.id,
    ).toBe("address_parts");
    // At the cap → give up on the address and move on to the next field.
    expect(
      nextTriageStep(base(stillBad, { addressAttempts: MAX_ADDRESS_REPROMPTS }))?.id,
    ).not.toBe("address_parts");
  });

  it("applyTriageAnswer increments the attempt counter each re-prompt", () => {
    const before = base("somewhere downtown");
    const step = nextTriageStep(before)!;
    expect(step.id).toBe("address_parts");
    const after = applyTriageAnswer(before, step, "still not a real address");
    expect(Number(after.extras.addressAttempts)).toBe(1);
  });

  it("a re-typed full US street at the re-prompt replaces (not appends) the bad address", () => {
    const before = base("not a real address");
    const after = applyTriageAnswer(
      before,
      { id: "address_parts", question: "", quickReplies: [], optional: false },
      "120 Broadway, New York, NY 10001",
    );
    expect(after.address).toBe("120 Broadway, New York, NY 10001");
    expect(nextTriageStep(after)?.id).not.toBe("address_parts");
  });
});

describe("core fields are unskippable", () => {
  it("UNSKIPPABLE_CORE lists the four hard-required core slots (email is skippable after MAX_EMAIL_REPROMPTS)", () => {
    expect(UNSKIPPABLE_CORE).toEqual([
      "issueType",
      "address",
      "name",
      "phone",
    ]);
  });

  it("skipping the address step does NOT advance (re-asks)", () => {
    const before = slots({
      safetyScreenPassed: true,
      extras: { systemDownStatus: "fully_down", problemDuration: "today" },
    });
    const step = nextTriageStep(before)!;
    expect(step.id).toBe("address");
    // A skip writes nothing to the core address slot → still asks address.
    const after = applyTriageAnswer(before, step, "skip");
    expect(after.address).toBeNull();
    expect(nextTriageStep(after)?.id).toBe("address");
  });

  it("skipping the name step does NOT advance (re-asks)", () => {
    const before = slots({
      safetyScreenPassed: true,
      address: COMPLETE_ADDRESS,
      phone: "555-1234",
      extras: { systemDownStatus: "fully_down", problemDuration: "today" },
    });
    const step = nextTriageStep(before)!;
    expect(step.id).toBe("name");
    const after = applyTriageAnswer(before, step, "skip");
    expect(after.name).toBeNull();
    expect(nextTriageStep(after)?.id).toBe("name");
  });

  it("skipping the email step does NOT advance (re-asks)", () => {
    const before = slots({
      safetyScreenPassed: true,
      address: COMPLETE_ADDRESS,
      phone: "555-1234",
      name: "Jane Doe",
      extras: { systemDownStatus: "fully_down", problemDuration: "today" },
    });
    const step = nextTriageStep(before)!;
    expect(step.id).toBe("email");
    const after = applyTriageAnswer(before, step, "skip");
    expect(after.email).toBeNull();
    expect(nextTriageStep(after)?.id).toBe("email");
  });
});

describe("Step 15 — issue-conditional enrichment (selectEnrichmentOrder)", () => {
  function coreReady(issueType: string, extras: Record<string, unknown> = {}): TriageSlots {
    return slots({
      issueType,
      safetyScreenPassed: true,
      urgency: "high",
      address: COMPLETE_ADDRESS,
      name: "Jane Doe",
      phone: "555-1234",
      email: "jane@example.com",
      extras: { systemDownStatus: "fully_down", problemDuration: "today", ...extras },
    });
  }

  it("no-heat asks vulnerable-occupants first (priority signal), then window", () => {
    expect(nextTriageStep(coreReady("heating_not_working"))?.id).toBe(
      "vulnerable_occupants",
    );
    // after answering vulnerable → window
    const next = nextTriageStep(coreReady("heating_not_working", { vulnerableOccupants: true }));
    expect(next?.id).toBe("preferred_window");
  });

  it("no-cool asks vulnerable-occupants first, then window", () => {
    expect(nextTriageStep(coreReady("cooling_not_working"))?.id).toBe(
      "vulnerable_occupants",
    );
  });

  it("repair-vs-replace classes ask equipment age first (maintenance/installation/noises/leak)", () => {
    for (const issue of [
      "maintenance",
      "installation",
      "strange_noises",
      "water_leak",
    ]) {
      expect(nextTriageStep(coreReady(issue))?.id).toBe("equipment_age");
    }
    // after answering age → window
    const next = nextTriageStep(coreReady("maintenance", { equipmentAgeBand: "over_15" }));
    expect(next?.id).toBe("preferred_window");
  });

  it("falls back to [system_type, window] for an issue with no specific qualifier", () => {
    expect(nextTriageStep(coreReady("thermostat_issue"))?.id).toBe("system_type");
    expect(nextTriageStep(coreReady("air_quality"))?.id).toBe("system_type");
  });

  it("falls back to generic order when issueType is null (unclassified)", () => {
    const s = coreReady("thermostat_issue");
    s.issueType = null;
    expect(nextTriageStep(s)?.id).toBe("system_type");
  });

  it("NEVER asks more than MAX_ENRICHMENT_STEPS (cap holds across every issue)", () => {
    const issues = [
      "heating_not_working",
      "cooling_not_working",
      "maintenance",
      "installation",
      "strange_noises",
      "water_leak",
      "thermostat_issue",
      "air_quality",
    ];
    for (const issue of issues) {
      let s = coreReady(issue);
      const asked: string[] = [];
      for (let i = 0; i < 10; i++) {
        const step = nextTriageStep(s);
        if (!step) break;
        asked.push(step.id);
        s = applyTriageAnswer(s, step, step.quickReplies[0]?.value ?? "morning");
      }
      expect(asked.length).toBeLessThanOrEqual(MAX_ENRICHMENT_STEPS);
    }
  });

  it("selectEnrichmentOrder returns at most MAX_ENRICHMENT_STEPS steps", () => {
    for (const issue of [
      "heating_not_working",
      "maintenance",
      "thermostat_issue",
      null,
    ]) {
      expect(selectEnrichmentOrder(issue).length).toBeLessThanOrEqual(
        MAX_ENRICHMENT_STEPS,
      );
    }
  });

  it("issue-specific qualifiers round-trip into existing CRM extra slots (no ephemeral leakage)", () => {
    // vulnerableOccupants + equipmentAgeBand are REAL optionalIntakeFields, so a
    // captured answer persists to the CRM rather than being a stripped sentinel.
    const heat = applyTriageAnswer(
      coreReady("heating_not_working"),
      nextTriageStep(coreReady("heating_not_working"))!,
      "yes",
    );
    expect(heat.extras.vulnerableOccupants).toBe(true);

    const maint = applyTriageAnswer(
      coreReady("maintenance"),
      nextTriageStep(coreReady("maintenance"))!,
      "over_15",
    );
    expect(maint.extras.equipmentAgeBand).toBe("over_15");
  });

  it("a per-issue qualifier that is skipped is not re-asked (skip sentinel)", () => {
    const s = coreReady("heating_not_working");
    const step = nextTriageStep(s)!;
    expect(step.id).toBe("vulnerable_occupants");
    const after = applyTriageAnswer(s, step, "skip");
    expect(nextTriageStep(after)?.id).not.toBe("vulnerable_occupants");
  });
});
