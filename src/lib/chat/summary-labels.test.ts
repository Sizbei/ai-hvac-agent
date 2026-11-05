import { describe, it, expect } from "vitest";
import { urgencyLabel, sentenceCase } from "./summary-labels";

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
