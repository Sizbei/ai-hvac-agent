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
    phone: null,
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

  it("asks the comprehensive enrichment questions once required slots are filled", () => {
    const step = nextTriageStep(
      slots({
        safetyScreenPassed: true,
        urgency: "high",
        address: "5 Oak St",
        phone: "555-1234",
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
        phone: "555-1234",
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
      phone: "555-1234",
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
      phone: "555-1234",
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
  it("lists the hard gate (safety + issue + urgency + address + phone)", () => {
    expect(REQUIRED_FOR_SUBMIT).toEqual([
      "safetyScreenPassed",
      "issueType",
      "urgency",
      "address",
      "phone",
    ]);
  });
});
