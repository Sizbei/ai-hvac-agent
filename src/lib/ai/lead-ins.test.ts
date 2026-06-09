import { describe, it, expect } from "vitest";
import { leadInForIssue, withLeadIn } from "./lead-ins";
import type { IssueType } from "./router-types";

const ALL_ISSUES: readonly IssueType[] = [
  "cooling_not_working",
  "heating_not_working",
  "thermostat_issue",
  "air_quality",
  "strange_noises",
  "water_leak",
  "maintenance",
  "installation",
  "other",
];

describe("leadInForIssue", () => {
  it("returns a non-empty acknowledgement for every known issue type (non-emergency)", () => {
    for (const issue of ALL_ISSUES) {
      const lead = leadInForIssue(issue, "high", 0);
      expect(lead.length).toBeGreaterThan(0);
    }
  });

  it("returns '' for emergency urgency (never softens safety copy)", () => {
    for (const issue of ALL_ISSUES) {
      expect(leadInForIssue(issue, "emergency", 0)).toBe("");
    }
    // Even with no issue type, emergency stays empty.
    expect(leadInForIssue(null, "emergency", 2)).toBe("");
  });

  it("returns '' when the issue type is not yet known", () => {
    expect(leadInForIssue(null, "high", 0)).toBe("");
    expect(leadInForIssue(undefined, "medium", 1)).toBe("");
  });

  it("varies the lead-in by index so successive turns aren't identical", () => {
    const a = leadInForIssue("cooling_not_working", "high", 0);
    const b = leadInForIssue("cooling_not_working", "high", 1);
    expect(a).not.toBe(b);
  });

  it("rotates deterministically and wraps around the variant table", () => {
    const first = leadInForIssue("heating_not_working", "medium", 0);
    const wrapped = leadInForIssue("heating_not_working", "medium", 3);
    // 3 variants per issue → index 0 and index 3 select the same variant.
    expect(wrapped).toBe(first);
  });

  it("tolerates negative indices without throwing or returning empty", () => {
    const lead = leadInForIssue("water_leak", "low", -1);
    expect(lead.length).toBeGreaterThan(0);
  });
});

describe("withLeadIn", () => {
  const NEXT_QUESTION = "What's the service address?";

  it("prepends an acknowledgement before the next question on a non-emergency turn", () => {
    const reply = withLeadIn(NEXT_QUESTION, "cooling_not_working", "high", 0);
    // The next question is still present...
    expect(reply.endsWith(NEXT_QUESTION)).toBe(true);
    // ...and an acknowledgement precedes it (reply is strictly longer).
    expect(reply.length).toBeGreaterThan(NEXT_QUESTION.length);
    expect(reply.startsWith(leadInForIssue("cooling_not_working", "high", 0))).toBe(
      true,
    );
  });

  it("leaves emergency copy unchanged (no acknowledgement prepended)", () => {
    const safetyCopy =
      "Please get to safety — I'm connecting you to a person right now.";
    const reply = withLeadIn(safetyCopy, "heating_not_working", "emergency", 0);
    expect(reply).toBe(safetyCopy);
  });

  it("leaves the question unchanged when the issue type is unknown", () => {
    const reply = withLeadIn(NEXT_QUESTION, null, "high", 0);
    expect(reply).toBe(NEXT_QUESTION);
  });

  it("separates the lead-in and the question with a single space", () => {
    const reply = withLeadIn(NEXT_QUESTION, "thermostat_issue", "medium", 0);
    const lead = leadInForIssue("thermostat_issue", "medium", 0);
    expect(reply).toBe(`${lead} ${NEXT_QUESTION}`);
  });
});
