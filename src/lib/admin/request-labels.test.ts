import { describe, it, expect } from "vitest";
import {
  customerNameLabel,
  humanizeSnake,
  inSentence,
  isCodeShaped,
  codeOrTextLabel,
  issueTypeLabel,
  jobTypeLabel,
  urgencyLabel,
} from "./request-labels";

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
    expect(humanizeSnake("__")).toBe("");
  });
  it("keeps an imported free-text title as typed (no lowercasing, dashes kept)", () => {
    expect(issueTypeLabel("Marlow's Deli W. Main St Kestrel: PREP TABLE IS LEAKING")).toBe(
      "Marlow's Deli W. Main St Kestrel: PREP TABLE IS LEAKING",
    );
    expect(issueTypeLabel("ON CALL: TROY 8/10-8/16 ☎️📞")).toBe("ON CALL: TROY 8/10-8/16 ☎️📞");
    expect(issueTypeLabel("Job for Dana 8-4-26")).toBe("Job for Dana 8-4-26");
    expect(issueTypeLabel("  Ice   Machine \n PM ")).toBe("Ice Machine PM");
    expect(issueTypeLabel("Boiler")).toBe("Boiler");
  });
  it("tells enum codes from free text", () => {
    expect(isCodeShaped("water_leak")).toBe(true);
    expect(isCodeShaped("tune-up")).toBe(true);
    expect(isCodeShaped("boiler")).toBe(true);
    expect(isCodeShaped("HVAC DOWN")).toBe(false);
    expect(isCodeShaped("Ice Machine")).toBe(false);
    expect(isCodeShaped("a__b")).toBe(false);
  });
  it("labels a missing customer name without saying Unknown", () => {
    expect(customerNameLabel("Marlow's Deli Ashgrove")).toBe("Marlow's Deli Ashgrove");
    expect(customerNameLabel(null)).toBe("No name on file");
    expect(customerNameLabel("   ")).toBe("No name on file");
  });
});

describe("codeOrTextLabel (the one shared rule)", () => {
  it("humanizes machine codes", () => {
    expect(codeOrTextLabel("water_leak")).toBe("Water leak");
    expect(codeOrTextLabel("tune-up")).toBe("Tune up");
    expect(codeOrTextLabel("COOLING_NOT_WORKING")).toBe("Cooling not working");
    expect(codeOrTextLabel("boiler")).toBe("Boiler");
  });
  it("shows free text exactly as typed, whitespace collapsed", () => {
    expect(codeOrTextLabel("Job for Hollow Creek Community Chapel")).toBe(
      "Job for Hollow Creek Community Chapel",
    );
    expect(codeOrTextLabel("hccc open door classroom")).toBe("hccc open door classroom");
    expect(codeOrTextLabel("  HVAC   DOWN ")).toBe("HVAC DOWN");
    expect(codeOrTextLabel("Mall")).toBe("Mall");
    expect(codeOrTextLabel("iPad repair")).toBe("iPad repair");
  });
  it("is empty for nothing", () => {
    expect(codeOrTextLabel(null)).toBe("");
    expect(codeOrTextLabel(undefined)).toBe("");
    expect(codeOrTextLabel("   ")).toBe("");
  });
});
