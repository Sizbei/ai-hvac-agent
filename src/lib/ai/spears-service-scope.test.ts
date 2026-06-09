import { describe, it, expect } from "vitest";
import { routeMessage } from "./intent-router";
import { jobTypeForIssue, issueTypeValues } from "./extraction-schema";
import type { IssueType } from "./router-types";

/**
 * Spears Services scope: the bot is scoped to FIVE service lines —
 * HVAC, commercial refrigeration, ice machines, boilers, and commercial
 * appliance repair. Natural phrasing for each of those must route to a repair
 * intake (COLLECT_INFO) with the right issueType and must NOT be sent to the
 * out-of-scope redirect. Genuinely out-of-scope work (plumbing, roofing,
 * electrical) must still redirect.
 *
 * These guard the intent-router deconfliction: the new commercial service-line
 * intents share keywords ("not cooling", "not heating", "freezer", "boiler")
 * with the existing residential HVAC intents, so this catches collisions and
 * the compound-message fallback swallowing a clear single-service request.
 */

interface ScopeExpectation {
  readonly message: string;
  readonly intentId: string;
  readonly issueType: IssueType;
}

const IN_SCOPE: readonly ScopeExpectation[] = [
  // refrigeration — walk-in / reach-in / display case / beverage cooler
  {
    message: "my walk-in cooler is not cooling",
    intentId: "refrigeration-not-cooling",
    issueType: "refrigeration",
  },
  {
    message: "reach-in freezer not freezing",
    intentId: "refrigeration-not-cooling",
    issueType: "refrigeration",
  },
  {
    message: "the display case isn't cold",
    intentId: "refrigeration-not-cooling",
    issueType: "refrigeration",
  },
  {
    message: "the beverage cooler stopped cooling",
    intentId: "refrigeration-not-cooling",
    issueType: "refrigeration",
  },
  // ice machines (commercial; brands serviced)
  {
    message: "ice machine not making ice",
    intentId: "ice-machine-issue",
    issueType: "ice_machine",
  },
  {
    message: "our hoshizaki ice machine is leaking",
    intentId: "ice-machine-issue",
    issueType: "ice_machine",
  },
  {
    message: "the ice maker has no ice",
    intentId: "ice-machine-issue",
    issueType: "ice_machine",
  },
  // boilers (gas/electric/oil)
  {
    message: "boiler no heat",
    intentId: "boiler-issue",
    issueType: "boiler",
  },
  {
    message: "the boiler is leaking",
    intentId: "boiler-issue",
    issueType: "boiler",
  },
  {
    message: "boiler not firing",
    intentId: "boiler-issue",
    issueType: "boiler",
  },
  // commercial appliances (ranges, ovens, fryers, grills, holding cabinets)
  {
    message: "commercial oven won't heat",
    intentId: "commercial-appliance-issue",
    issueType: "commercial_appliance",
  },
  {
    message: "the deep fryer is not heating",
    intentId: "commercial-appliance-issue",
    issueType: "commercial_appliance",
  },
  {
    message: "our commercial range is not working",
    intentId: "commercial-appliance-issue",
    issueType: "commercial_appliance",
  },
];

describe("Spears commercial service lines route to a repair intake", () => {
  for (const { message, intentId, issueType } of IN_SCOPE) {
    it(`"${message}" -> ${intentId} (COLLECT_INFO, ${issueType})`, () => {
      const v = routeMessage(message);
      expect(v.action).toBe("COLLECT_INFO");
      expect(v.intentId).toBe(intentId);
      expect(v.issueType).toBe(issueType);
      // It must collect the service address next, never redirect away.
      expect(v.reply).toBeTruthy();
    });

    it(`"${message}" is NOT sent to the out-of-scope redirect`, () => {
      const v = routeMessage(message);
      expect(v.action).not.toBe("REDIRECT");
      expect(v.intentId).not.toBe("meta-non-hvac-redirect");
    });
  }
});

describe("existing residential HVAC intents still own their phrasing", () => {
  // The new commercial negationGuards must NOT steal the plain residential
  // HVAC requests they share keywords with.
  const HVAC: ReadonlyArray<readonly [string, string]> = [
    ["my ac is not cooling", "cooling-not-cooling"],
    ["the furnace is not heating", "heating-not-heating"],
  ];
  for (const [message, intentId] of HVAC) {
    it(`"${message}" still routes to ${intentId}`, () => {
      const v = routeMessage(message);
      expect(v.action).toBe("COLLECT_INFO");
      expect(v.intentId).toBe(intentId);
    });
  }
});

describe("the generic boiler capability question still falls back to the LLM", () => {
  // "do you work on boilers?" is a capability question, distinct from a boiler
  // SYMPTOM — it stays FALLBACK_LLM (equipment-boiler) so the LLM can gather
  // context, while a symptom is captured by boiler-issue (tested above).
  it("'do you work on boilers?' -> FALLBACK_LLM", () => {
    const v = routeMessage("do you work on boilers?");
    expect(v.action).toBe("FALLBACK_LLM");
    expect(v.intentId).toBeNull();
  });
});

describe("genuinely out-of-scope work still redirects in brand voice", () => {
  const OUT_OF_SCOPE: readonly string[] = [
    "I need a plumber for a clogged toilet",
    "can you fix my roof?",
    "I need an electrician for some wiring",
    "my garage door is broken",
  ];
  for (const message of OUT_OF_SCOPE) {
    it(`"${message}" -> REDIRECT`, () => {
      const v = routeMessage(message);
      expect(v.action).toBe("REDIRECT");
      expect(v.intentId).toBe("meta-non-hvac-redirect");
      // Redirect must NOT stamp a bogus issueType onto the session.
      expect(v.issueType).toBeNull();
    });
  }

  it("the redirect names the in-scope service lines (refrigeration + commercial)", () => {
    const v = routeMessage("can you do my taxes?");
    expect(v.action).toBe("REDIRECT");
    expect(v.reply).toBeTruthy();
    const reply = (v.reply ?? "").toLowerCase();
    expect(reply).toContain("refrigeration");
    expect(reply).toContain("commercial");
  });

  it("does NOT redirect refrigeration/appliance core business (regression)", () => {
    // The old redirect listed "refrigerator"/"fridge"/"appliance repair" as
    // triggers — exactly Spears' core business. Those must no longer redirect.
    for (const message of [
      "my walk-in cooler is broken",
      "commercial appliance repair please",
      "ice machine repair",
    ]) {
      const v = routeMessage(message);
      expect(v.intentId).not.toBe("meta-non-hvac-redirect");
      expect(v.action).not.toBe("REDIRECT");
    }
  });
});

describe("new issueType values map to jobType without a pg-enum migration", () => {
  // service_requests.issue_type is a TEXT column, so new issueType values need
  // no migration. job_type IS a pg enum, so the new service lines must reuse an
  // EXISTING jobType — they all fall through to the generic 'service_call'.
  it("includes the four new Spears service-line issue types", () => {
    expect(issueTypeValues).toContain("refrigeration");
    expect(issueTypeValues).toContain("ice_machine");
    expect(issueTypeValues).toContain("boiler");
    expect(issueTypeValues).toContain("commercial_appliance");
  });

  it("maps each new issueType to the existing 'service_call' jobType", () => {
    expect(jobTypeForIssue("refrigeration")).toBe("service_call");
    expect(jobTypeForIssue("ice_machine")).toBe("service_call");
    expect(jobTypeForIssue("boiler")).toBe("service_call");
    expect(jobTypeForIssue("commercial_appliance")).toBe("service_call");
  });

  it("leaves the existing HVAC issueType -> jobType mappings unchanged", () => {
    expect(jobTypeForIssue("heating_not_working")).toBe("no_heat");
    expect(jobTypeForIssue("cooling_not_working")).toBe("no_cool");
    expect(jobTypeForIssue("maintenance")).toBe("maintenance");
    expect(jobTypeForIssue("installation")).toBe("install");
    expect(jobTypeForIssue(null)).toBeNull();
  });
});
