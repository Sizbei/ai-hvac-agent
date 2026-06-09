import { describe, it, expect } from "vitest";
import {
  sanitizeName,
  sanitizePhone,
  sanitizeAddress,
  sanitizeEmail,
  sanitizeContactFields,
} from "./sanitize-fields";

describe("sanitizeName", () => {
  it("title-cases a simple lowercase name", () => {
    expect(sanitizeName("brian hoang")).toBe("Brian Hoang");
  });
  it("down-cases SHOUTING and collapses whitespace", () => {
    expect(sanitizeName("JOHN   SMITH")).toBe("John Smith");
  });
  it("handles apostrophes (O'Brien, D'Angelo)", () => {
    expect(sanitizeName("o'brien")).toBe("O'Brien");
    expect(sanitizeName("d'angelo")).toBe("D'Angelo");
  });
  it("handles hyphenated names", () => {
    expect(sanitizeName("anne-marie watson")).toBe("Anne-Marie Watson");
  });
  it("handles Mc/Mac prefixes", () => {
    expect(sanitizeName("mcdonald")).toBe("McDonald");
    expect(sanitizeName("macleod")).toBe("MacLeod");
  });
  it("trims surrounding whitespace", () => {
    expect(sanitizeName("  jane doe  ")).toBe("Jane Doe");
  });
  it("leaves an empty string empty", () => {
    expect(sanitizeName("   ")).toBe("");
  });
});

describe("sanitizePhone", () => {
  it("formats bare 10 digits", () => {
    expect(sanitizePhone("5551234567")).toBe("(555) 123-4567");
  });
  it("reformats a dashed number", () => {
    expect(sanitizePhone("555-123-4567")).toBe("(555) 123-4567");
  });
  it("reformats a dotted number", () => {
    expect(sanitizePhone("555.123.4567")).toBe("(555) 123-4567");
  });
  it("keeps a +1 country code", () => {
    expect(sanitizePhone("+1 555 123 4567")).toBe("+1 (555) 123-4567");
    expect(sanitizePhone("1 (555) 123 4567")).toBe("+1 (555) 123-4567");
  });
  it("leaves a non-NANP shape collapsed but unmangled", () => {
    expect(sanitizePhone("555-1234")).toBe("555-1234");
    expect(sanitizePhone("+44 20 7946 0958")).toBe("+44 20 7946 0958");
  });
});

describe("sanitizeAddress", () => {
  it("title-cases, fixes comma spacing, upper-cases the state, keeps the ZIP", () => {
    expect(sanitizeAddress("123 main st  ,knoxville tn 37920")).toBe(
      "123 Main St, Knoxville TN 37920",
    );
  });
  it("down-cases a SHOUTING address", () => {
    expect(sanitizeAddress("456 OAK AVENUE, JOHNSON CITY TN 37601")).toBe(
      "456 Oak Avenue, Johnson City TN 37601",
    );
  });
  it("preserves unit tokens with digits", () => {
    expect(sanitizeAddress("789 elm st apt 4b, bristol va 24201")).toContain(
      "Apt 4b",
    );
  });
  it("does not upper-case a 2-letter word that is not a state", () => {
    // "Of" isn't a state code → stays title-cased, not "OF".
    expect(sanitizeAddress("1 of something rd")).toBe("1 Of Something Rd");
  });
});

describe("sanitizeEmail", () => {
  it("lowercases and strips whitespace", () => {
    expect(sanitizeEmail("  Brian.Hoang@Example.COM ")).toBe(
      "brian.hoang@example.com",
    );
  });
});

describe("sanitizeContactFields", () => {
  it("cleans all four fields immutably and preserves other props", () => {
    const input = {
      customerName: "brian hoang",
      customerPhone: "5551234567",
      customerEmail: " B@X.COM ",
      address: "12 oak st, knoxville tn 37920",
      issueType: "cooling_not_working" as const,
      description: "AC is out",
    };
    const out = sanitizeContactFields(input);
    expect(out).not.toBe(input); // new object
    expect(input.customerName).toBe("brian hoang"); // input untouched
    expect(out.customerName).toBe("Brian Hoang");
    expect(out.customerPhone).toBe("(555) 123-4567");
    expect(out.customerEmail).toBe("b@x.com");
    expect(out.address).toBe("12 Oak St, Knoxville TN 37920");
    // Non-contact props pass through.
    expect(out.issueType).toBe("cooling_not_working");
    expect(out.description).toBe("AC is out");
  });

  it("passes null / blank values through untouched", () => {
    const out = sanitizeContactFields({
      customerName: null,
      customerPhone: undefined,
      customerEmail: "   ",
      address: null,
    });
    expect(out.customerName).toBeNull();
    expect(out.customerPhone).toBeUndefined();
    expect(out.customerEmail).toBe("   ");
    expect(out.address).toBeNull();
  });
});
