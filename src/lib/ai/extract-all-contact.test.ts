import { describe, it, expect } from "vitest";
import { extractAllContactFields } from "./extract-all-contact";

describe("extractAllContactFields", () => {
  it("captures name AND phone from one message (the transcript bug)", () => {
    const r = extractAllContactFields("ray chen, 4169029212");
    expect(r.name).toBe("Ray Chen");
    expect(r.phone).toBe("4169029212");
    expect(r.email).toBeNull();
    expect(r.address).toBeNull();
  });

  it("captures name AND email from one message", () => {
    const r = extractAllContactFields("Ray Chen ray@example.com");
    expect(r.name).toBe("Ray Chen");
    expect(r.email).toBe("ray@example.com");
  });

  it("captures the street address and email together", () => {
    // Loose extraction grabs the street ("120 Broadway"); the strict completeness
    // gate + the address_parts follow-up fill in city/ZIP downstream.
    const r = extractAllContactFields(
      "120 Broadway, Johnson City, TN 37604, ray@example.com",
    );
    expect(r.address).toContain("120 Broadway");
    expect(r.email).toBe("ray@example.com");
  });

  it("does not invent a name from a lone word", () => {
    expect(extractAllContactFields("Broadway").name).toBeNull();
    expect(extractAllContactFields("help").name).toBeNull();
  });

  it("does not treat a street as a name", () => {
    // Leading number is stripped; residual 'Broadway' is one word → not a name.
    const r = extractAllContactFields("120 Broadway");
    expect(r.name).toBeNull();
  });

  it("strips a polite preamble before the name", () => {
    expect(extractAllContactFields("it's Raymond Chen, 4169029212").name).toBe(
      "Raymond Chen",
    );
  });

  it("respects allowResidualName=false (name left to the name step)", () => {
    const r = extractAllContactFields("ray chen, 4169029212", {
      allowResidualName: false,
    });
    expect(r.name).toBeNull();
    expect(r.phone).toBe("4169029212");
  });

  it("returns all-null for a message with no contact data", () => {
    const r = extractAllContactFields("my ac is broken");
    expect(r).toEqual({ name: null, phone: null, email: null, address: null });
  });

  it("does not mistake issue prose for a name (review H7)", () => {
    expect(extractAllContactFields("my ac is broken, 4169029212").name).toBeNull();
    expect(extractAllContactFields("furnace not working 416-902-9212").name).toBeNull();
    expect(extractAllContactFields("no heat, reach me at ray@x.com").name).toBeNull();
    // …while the phone/email are still captured
    expect(extractAllContactFields("my ac is broken, 4169029212").phone).toBe("4169029212");
  });

  it("still extracts a genuine name alongside contact info", () => {
    expect(extractAllContactFields("Ray Chen, 4169029212").name).toBe("Ray Chen");
    expect(extractAllContactFields("Sarah Miller sarah@x.com").name).toBe("Sarah Miller");
  });
});
