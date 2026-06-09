import { describe, it, expect } from "vitest";
import {
  nextTriageStep,
  applyTriageAnswer,
  isSkip,
  REQUIRED_FOR_SUBMIT,
  type TriageSlots,
} from "./triage";

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

  it("asks for phone (required) after address", () => {
    const step = nextTriageStep(
      slots({
        safetyScreenPassed: true,
        address: "5 Oak St",
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }),
    );
    expect(step?.id).toBe("phone");
  });

  it("asks for the customer's full name after phone, before urgency", () => {
    const step = nextTriageStep(
      slots({
        safetyScreenPassed: true,
        address: "5 Oak St",
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
        address: "5 Oak St",
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
        address: "5 Oak St",
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
        address: "5 Oak St",
        phone: "555-1234",
        name: "Jane Doe",
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }),
    );
    expect(step?.id).not.toBe("name");
  });

  it("asks the comprehensive enrichment questions once required slots are filled", () => {
    const step = nextTriageStep(
      slots({
        safetyScreenPassed: true,
        urgency: "high",
        address: "5 Oak St",
        name: "Jane Doe",
        phone: "555-1234",
        email: "jane@example.com",
        extras: { systemDownStatus: "fully_down", problemDuration: "today" },
      }),
    );
    // Should be one of the enrichment steps (systemType is the first).
    expect(step?.id).toBe("system_type");
    expect(step!.optional).toBe(true);
  });

  it("returns null (ready to confirm) when required + enrichment are all answered or skipped", () => {
    const step = nextTriageStep(
      slots({
        safetyScreenPassed: true,
        urgency: "high",
        address: "5 Oak St",
        name: "Jane Doe",
        phone: "555-1234",
        email: "jane@example.com",
        extras: {
          systemDownStatus: "fully_down",
          problemDuration: "today",
          systemType: "central_ac",
          equipmentAgeBand: "10_to_15",
          equipmentBrand: "Trane",
          propertyType: "residential",
          ownerOccupant: "owner",
          underWarranty: "unknown",
          accessNotes: "none",
          vulnerableOccupants: false,
          preferredWindow: "morning",
          contactPreference: "call",
          leadSource: "google",
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
        address: "5 Oak St",
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
      safetyScreenPassed: true,
      urgency: "high",
      address: "5 Oak St",
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
      safetyScreenPassed: true,
      urgency: "high",
      address: "5 Oak St",
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
        safetyScreenPassed: true,
        urgency: "high",
        address: "5 Oak St",
        phone: "555-1234",
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
