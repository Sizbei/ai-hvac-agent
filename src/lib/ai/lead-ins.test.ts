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
  // `index` is the route's newTurnCount (1 on the first user turn). Empathy is
  // emitted ONCE, on that first acknowledgement turn (index === 1), then "".
  const ACK_TURN = 1;

  it("returns a non-empty acknowledgement for every known issue type on the first turn", () => {
    for (const issue of ALL_ISSUES) {
      const lead = leadInForIssue(issue, "high", ACK_TURN);
      expect(lead.length).toBeGreaterThan(0);
    }
  });

  it("returns '' for emergency urgency (never softens safety copy)", () => {
    for (const issue of ALL_ISSUES) {
      expect(leadInForIssue(issue, "emergency", ACK_TURN)).toBe("");
    }
    // Even with no issue type, emergency stays empty.
    expect(leadInForIssue(null, "emergency", 2)).toBe("");
  });

  it("returns '' when the issue type is not yet known", () => {
    expect(leadInForIssue(null, "high", ACK_TURN)).toBe("");
    expect(leadInForIssue(undefined, "medium", ACK_TURN)).toBe("");
  });

  it("emits empathy ONCE on the first turn, then '' on every later turn", () => {
    const first = leadInForIssue("cooling_not_working", "high", ACK_TURN);
    expect(first.length).toBeGreaterThan(0);
    // Subsequent collecting turns get no fresh acknowledgement.
    expect(leadInForIssue("cooling_not_working", "high", 2)).toBe("");
    expect(leadInForIssue("cooling_not_working", "high", 3)).toBe("");
    expect(leadInForIssue("cooling_not_working", "high", 7)).toBe("");
  });

  it("returns '' before the first user turn (greeting turn, index 0)", () => {
    expect(leadInForIssue("heating_not_working", "medium", 0)).toBe("");
  });

  it("is deterministic for the same issue on the acknowledgement turn", () => {
    const a = leadInForIssue("heating_not_working", "medium", ACK_TURN);
    const b = leadInForIssue("heating_not_working", "medium", ACK_TURN);
    expect(b).toBe(a);
  });

  it("returns '' for negative indices (only turn 1 acknowledges)", () => {
    expect(leadInForIssue("water_leak", "low", -1)).toBe("");
  });
});

describe("withLeadIn", () => {
  const NEXT_QUESTION = "What's the service address?";
  const ACK_TURN = 1;

  it("prepends an acknowledgement before the next question on the first turn", () => {
    const reply = withLeadIn(NEXT_QUESTION, "cooling_not_working", "high", ACK_TURN);
    // The next question is still present...
    expect(reply.endsWith(NEXT_QUESTION)).toBe(true);
    // ...and an acknowledgement precedes it (reply is strictly longer).
    expect(reply.length).toBeGreaterThan(NEXT_QUESTION.length);
    expect(
      reply.startsWith(leadInForIssue("cooling_not_working", "high", ACK_TURN)),
    ).toBe(true);
  });

  it("leaves later-turn questions unchanged (empathy-once)", () => {
    const reply = withLeadIn(NEXT_QUESTION, "cooling_not_working", "high", 3);
    expect(reply).toBe(NEXT_QUESTION);
  });

  it("leaves emergency copy unchanged (no acknowledgement prepended)", () => {
    const safetyCopy =
      "Please get to safety — I'm connecting you to a person right now.";
    const reply = withLeadIn(
      safetyCopy,
      "heating_not_working",
      "emergency",
      ACK_TURN,
    );
    expect(reply).toBe(safetyCopy);
  });

  it("leaves the question unchanged when the issue type is unknown", () => {
    const reply = withLeadIn(NEXT_QUESTION, null, "high", ACK_TURN);
    expect(reply).toBe(NEXT_QUESTION);
  });

  it("separates the lead-in and the question with a single space", () => {
    const reply = withLeadIn(NEXT_QUESTION, "thermostat_issue", "medium", ACK_TURN);
    const lead = leadInForIssue("thermostat_issue", "medium", ACK_TURN);
    expect(reply).toBe(`${lead} ${NEXT_QUESTION}`);
  });
});
