import { describe, it, expect } from "vitest";
import { humanizeCode, inSentence, issueTypeLabel, jobTypeLabel, urgencyLabel } from "./request-labels";

describe("request labels", () => {
  it("maps known issue codes to the New request dialog wording", () => {
    expect(issueTypeLabel("cooling_not_working")).toBe("Cooling not working");
    expect(issueTypeLabel("thermostat_issue")).toBe("Thermostat");
    expect(issueTypeLabel("water_leak")).toBe("Water leak");
  });
  it("humanizes an unknown code instead of showing it raw", () => {
    expect(issueTypeLabel("duct_cleaning")).toBe("Duct cleaning");
    expect(jobTypeLabel("tune-up")).toBe("Tune up");
  });
  it("falls back for empty values", () => {
    expect(issueTypeLabel(null)).toBe("Service request");
    expect(issueTypeLabel("")).toBe("Service request");
    expect(jobTypeLabel(undefined)).toBe("Service call");
    expect(urgencyLabel(null)).toBe("Unknown");
  });
  it("labels job types and urgency", () => {
    expect(jobTypeLabel("service_call")).toBe("Service call");
    expect(jobTypeLabel("no_cool")).toBe("No cooling");
    expect(urgencyLabel("emergency")).toBe("Emergency");
  });
  it("never resolves prototype keys", () => {
    expect(issueTypeLabel("constructor")).toBe("Constructor");
  });
  it("inSentence lowers the first word but keeps acronyms", () => {
    expect(inSentence("Service call")).toBe("service call");
    expect(inSentence("AC tune")).toBe("AC tune");
    expect(humanizeCode("__")).toBe("");
  });
});
