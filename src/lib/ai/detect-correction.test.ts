import { describe, it, expect } from "vitest";
import {
  detectCorrection,
  extractNameFromCue,
  nameFromDirectAnswer,
  hasCorrectionCue,
  correctionFieldLabel,
} from "./detect-correction";

describe("nameFromDirectAnswer (answer to the NAME step)", () => {
  it("takes a bare name", () => {
    expect(nameFromDirectAnswer("Brian Hoang")).toBe("Brian Hoang");
  });
  it("strips a polite preamble", () => {
    expect(nameFromDirectAnswer("it's Brian Hoang")).toBe("Brian Hoang");
    expect(nameFromDirectAnswer("my name is Jane Doe")).toBe("Jane Doe");
    expect(nameFromDirectAnswer("I'm Sam Smith")).toBe("Sam Smith");
  });
  it("captures accented and international names (Unicode letters)", () => {
    expect(nameFromDirectAnswer("José García")).toBe("José García");
    expect(nameFromDirectAnswer("Müller Schmidt")).toBe("Müller Schmidt");
    expect(nameFromDirectAnswer("Renée O'Brien")).toBe("Renée O'Brien");
  });
  it("rejects an answer containing digits (likely a phone/address)", () => {
    expect(nameFromDirectAnswer("865-555-1212")).toBeNull();
    expect(nameFromDirectAnswer("123 Main St")).toBeNull();
  });
  it("rejects an over-long rambling answer", () => {
    expect(
      nameFromDirectAnswer("well it is a bit complicated but you can call me"),
    ).toBeNull();
  });
  it("rejects refusals and skips (not a name)", () => {
    for (const reply of [
      "skip",
      "pass",
      "none",
      "no",
      "nope",
      "no thanks",
      "no thank you",
      "rather not",
      "prefer not",
      "maybe later",
    ]) {
      expect(nameFromDirectAnswer(reply)).toBeNull();
    }
  });
  it("rejects questions and commands asked at the name step", () => {
    for (const reply of [
      "what are your hours",
      "what are your hours?",
      "who is this?",
      "how much does it cost",
      "tell me your prices",
      "help me",
      "cancel",
    ]) {
      expect(nameFromDirectAnswer(reply)).toBeNull();
    }
  });
  it("still accepts real names that resemble common words", () => {
    // Guard against over-rejection: these are legitimate first names.
    expect(nameFromDirectAnswer("Will")).toBe("Will");
    expect(nameFromDirectAnswer("Grace")).toBe("Grace");
    expect(nameFromDirectAnswer("Hope")).toBe("Hope");
    expect(nameFromDirectAnswer("May")).toBe("May");
  });
});

describe("extractNameFromCue (explicit name correction)", () => {
  it("pulls the name after a cue", () => {
    expect(extractNameFromCue("actually my name is Brian Hwang")).toBe(
      "Brian Hwang",
    );
    expect(extractNameFromCue("change my name to Robert Lee")).toBe(
      "Robert Lee",
    );
    expect(extractNameFromCue("call me Mike")).toBe("Mike");
  });
  it("pulls an accented name after a cue", () => {
    expect(extractNameFromCue("my name is José García")).toBe("José García");
  });
  it("stops at trailing filler", () => {
    expect(extractNameFromCue("my name is Brian thanks")).toBe("Brian");
  });
  it("returns null with no cue", () => {
    expect(extractNameFromCue("the weather is nice")).toBeNull();
  });
});

describe("detectCorrection", () => {
  it("captures the name when the NAME step was just asked", () => {
    expect(detectCorrection("Brian Hoang", "name")).toEqual({
      field: "name",
      value: "Brian Hoang",
    });
  });

  it("does NOT treat a random message as a name outside the name step", () => {
    expect(detectCorrection("my AC is broken", null)).toBeNull();
  });

  it("detects a phone correction", () => {
    expect(
      detectCorrection("actually my number is 865-555-1212", null),
    ).toEqual({ field: "phone", value: "865-555-1212" });
  });

  it("detects an address correction", () => {
    const out = detectCorrection(
      "wait, change the address to 5 Oak St, Bristol TN 37620",
      null,
    );
    expect(out?.field).toBe("address");
    expect(out?.value).toContain("Oak St");
  });

  it("detects an email correction", () => {
    expect(
      detectCorrection("no, my email is actually brian@example.com", null),
    ).toEqual({ field: "email", value: "brian@example.com" });
  });

  it("detects a name correction via cue", () => {
    expect(
      detectCorrection("actually my name is Brian Hwang", null),
    ).toEqual({ field: "name", value: "Brian Hwang" });
  });

  it("accepts a bare corrected phone with a cue but no field word", () => {
    expect(detectCorrection("no wait, 865-555-9999", null)).toEqual({
      field: "phone",
      value: "865-555-9999",
    });
  });

  it("returns null when a correction cue carries no extractable value", () => {
    expect(detectCorrection("actually never mind", null)).toBeNull();
  });

  it("does NOT misread a pronoun sentence as a name correction (regression)", () => {
    // "i'm"/"i am" are NOT name-targeting keywords — these must not corrupt the name.
    expect(
      detectCorrection("actually i'm worried about the cost", null),
    ).toBeNull();
    expect(
      detectCorrection("wait, I am calling from Johnson City", null),
    ).toBeNull();
    expect(
      detectCorrection("fix the problem, i am tired of waiting", null),
    ).toBeNull();
  });

  it("does NOT fire on common HVAC sentences containing fix/use/update/change", () => {
    expect(detectCorrection("I need someone to fix it", null)).toBeNull();
    expect(detectCorrection("I use my AC every day", null)).toBeNull();
    expect(detectCorrection("can you update me when you arrive", null)).toBeNull();
  });

  it("prefers the corrected name even when the name step is pending if a cue is present", () => {
    // At the name step, a bare answer is the name; a cue'd answer still yields a name.
    expect(detectCorrection("it's Brian Hoang", "name")).toEqual({
      field: "name",
      value: "Brian Hoang",
    });
  });
});

describe("hasCorrectionCue / correctionFieldLabel", () => {
  it("flags correction cues", () => {
    expect(hasCorrectionCue("actually it's wrong")).toBe(true);
    expect(hasCorrectionCue("my AC is broken")).toBe(false);
  });
  it("labels fields for the customer-facing ack", () => {
    expect(correctionFieldLabel("phone")).toBe("phone number");
    expect(correctionFieldLabel("name")).toBe("name");
    expect(correctionFieldLabel("address")).toBe("address");
    expect(correctionFieldLabel("email")).toBe("email");
  });
});
