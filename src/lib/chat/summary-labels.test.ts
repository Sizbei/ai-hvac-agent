import { describe, it, expect } from "vitest";
import { urgencyLabel, sentenceCase, compactSummary, ISSUE_TYPE_OPTIONS } from "./summary-labels";

describe("summary labels", () => {
  it("maps urgency enums to plain words", () => {
    expect(urgencyLabel("low")).toBe("Can wait");
    expect(urgencyLabel("medium")).toBe("Soon");
    expect(urgencyLabel("high")).toBe("Urgent");
    expect(urgencyLabel("emergency")).toBe("Emergency");
    expect(urgencyLabel("some_new_value")).toBe("Some new value");
  });

  it("sentence-cases issue types and keeps HVAC/AC", () => {
    expect(sentenceCase("thermostat_issue")).toBe("Thermostat issue");
    expect(sentenceCase("ac_not_cooling")).toBe("AC not cooling");
    expect(sentenceCase("hvac_maintenance")).toBe("HVAC maintenance");
    expect(sentenceCase("")).toBe("");
  });
});

describe("compactSummary", () => {
  it("joins issue, urgency and the street line", () => {
    expect(
      compactSummary({
        issueType: "cooling_not_working",
        urgency: "high",
        address: "12 Oak St, Johnson City, TN 37601",
      }),
    ).toBe("Cooling not working · Urgent · 12 Oak St");
  });
  it("skips missing parts", () => {
    expect(compactSummary({ issueType: "boiler", urgency: null, address: null })).toBe("Boiler");
    expect(compactSummary({})).toBe("");
  });
});

describe("ISSUE_TYPE_OPTIONS", () => {
  it("offers every issue type with a plain label, cooling included", () => {
    expect(ISSUE_TYPE_OPTIONS).toContainEqual({
      value: "cooling_not_working",
      label: "Cooling not working",
    });
    expect(ISSUE_TYPE_OPTIONS).toContainEqual({
      value: "heating_not_working",
      label: "Heating not working",
    });
  });
});
