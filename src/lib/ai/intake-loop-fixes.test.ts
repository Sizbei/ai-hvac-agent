/**
 * Regression tests for the intake loop/repeat fixes:
 *  - email re-ask cap (MAX_EMAIL_REPROMPTS) and retry copy with the skip affordance
 *  - skipped email satisfies the completeness gate (skip sentinel)
 *  - spoken word-digit phone numbers parse at the phone step
 */
import { describe, it, expect } from "vitest";
import { nextTriageStep, MAX_EMAIL_REPROMPTS } from "./triage";
import {
  isExtractionComplete,
  isAddressComplete,
  serviceRequestSchema,
} from "./extraction-schema";
import { SKIP_SENTINEL } from "./chat-slots";
import { extractSpokenPhone } from "./extract-spoken-phone";

const FILLED = {
  issueType: "cooling_not_working",
  urgency: "high",
  address: "212 E Unaka Ave, Johnson City, TN 37601",
  name: "Raymond Chen",
  phone: "423-555-0147",
  email: null as string | null,
  safetyScreenPassed: true,
  extras: {
    systemDownStatus: "fully_down",
    problemDuration: "1_day",
  } as Record<string, unknown>,
};

describe("email re-ask cap", () => {
  it("asks for the email when never asked before", () => {
    const step = nextTriageStep({ ...FILLED, extras: { ...FILLED.extras } });
    expect(step?.id).toBe("email");
    expect(step?.question).not.toContain("skip");
  });

  it("offers the skip affordance on the re-ask", () => {
    const step = nextTriageStep({
      ...FILLED,
      extras: { ...FILLED.extras, emailAttempts: 1 },
    });
    expect(step?.id).toBe("email");
    expect(step?.question.toLowerCase()).toContain("skip");
  });

  it("stops asking once MAX_EMAIL_REPROMPTS is reached", () => {
    const step = nextTriageStep({
      ...FILLED,
      extras: { ...FILLED.extras, emailAttempts: MAX_EMAIL_REPROMPTS },
    });
    expect(step?.id).not.toBe("email");
  });
});

describe("skipped email completeness", () => {
  const base = {
    issueType: "cooling_not_working",
    urgency: "high",
    address: "212 E Unaka Ave, Johnson City, TN 37601",
    customerName: "Raymond Chen",
    customerPhone: "423-555-0147",
    description: "AC not cooling",
  };

  it("treats the skip sentinel as a resolved email", () => {
    expect(
      isExtractionComplete({
        ...base,
        customerEmail: SKIP_SENTINEL,
      } as never),
    ).toBe(true);
  });

  it("still treats a missing email as incomplete", () => {
    expect(
      isExtractionComplete({ ...base, customerEmail: null } as never),
    ).toBe(false);
  });

  it("confirm schema accepts a null email but rejects junk", () => {
    expect(
      serviceRequestSchema.safeParse({ ...base, customerEmail: null }).success,
    ).toBe(true);
    expect(
      serviceRequestSchema.safeParse({ ...base, customerEmail: "junk" })
        .success,
    ).toBe(false);
    expect(
      serviceRequestSchema.safeParse({
        ...base,
        customerEmail: "ray@example.com",
      }).success,
    ).toBe(true);
  });
});

describe("spoken word-digit phone numbers", () => {
  it("parses digits spoken as words", () => {
    expect(
      extractSpokenPhone("four two three five five five zero one four seven"),
    ).toBe("423-555-0147");
  });

  it("parses mixed words and numerals with fillers", () => {
    expect(extractSpokenPhone("it's 423, five five five, 0147")).toBe(
      "423-555-0147",
    );
  });

  it("still parses plain numerals", () => {
    expect(extractSpokenPhone("423-555-0147")).toBe("423-555-0147");
  });

  it("rejects non-phone utterances", () => {
    expect(extractSpokenPhone("tomorrow morning works")).toBe(null);
  });
});

describe("rural named-route addresses", () => {
  it("accepts County Road / Highway style addresses with a ZIP", () => {
    expect(isAddressComplete("County Road 120, Mississippi 38683")).toBe(true);
    expect(isAddressComplete("Highway 64 East, Lebanon, TN 37087")).toBe(true);
    expect(isAddressComplete("State Route 34, Jonesborough, TN 37659")).toBe(
      true,
    );
  });

  it("still rejects named routes without a ZIP and non-addresses", () => {
    expect(isAddressComplete("County Road 120, Mississippi")).toBe(false);
    expect(isAddressComplete("the house on the county road")).toBe(false);
    expect(isAddressComplete("Maple Street, Johnson City, TN 37601")).toBe(
      false,
    );
  });

  it("still accepts conventional house-number addresses", () => {
    expect(isAddressComplete("212 E Unaka Ave, Johnson City, TN 37601")).toBe(
      true,
    );
  });
});

describe("addressVerified completeness override", () => {
  const base = {
    issueType: "cooling_not_working",
    urgency: "high",
    customerName: "Raymond Chen",
    customerPhone: "423-555-0147",
    customerEmail: "ray@example.com",
    description: "AC out",
  };

  it("a geocoded lookup selection completes even when the heuristic rejects it", () => {
    expect(
      isExtractionComplete({
        ...base,
        address: "Walnut, Mississippi",
        addressVerified: "yes",
      } as never),
    ).toBe(true);
  });

  it("an unverified heuristic-failing address stays incomplete", () => {
    expect(
      isExtractionComplete({
        ...base,
        address: "Walnut, Mississippi",
      } as never),
    ).toBe(false);
  });
});
