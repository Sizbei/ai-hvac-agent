import { describe, it, expect } from "vitest";
import {
  parseKnownSlots,
  mergeSlots,
  hasSlotData,
  buildExtraction,
} from "./chat-slots";

describe("parseKnownSlots", () => {
  it("returns empty object for null/invalid metadata", () => {
    expect(parseKnownSlots(null)).toEqual({});
    expect(parseKnownSlots("not json")).toEqual({});
    expect(parseKnownSlots("")).toEqual({});
  });

  it("maps ExtractionResult metadata to KnownSlots (customerName→name etc.)", () => {
    const meta = JSON.stringify({
      issueType: "cooling_not_working",
      urgency: "high",
      address: "742 Evergreen Terrace",
      customerName: "Jane",
      customerPhone: "555-1234",
      customerEmail: "j@x.com",
      description: "warm air",
      isHvacRelated: true,
    });
    expect(parseKnownSlots(meta)).toEqual({
      issueType: "cooling_not_working",
      urgency: "high",
      address: "742 Evergreen Terrace",
      name: "Jane",
      phone: "555-1234",
      email: "j@x.com",
    });
  });
});

describe("mergeSlots — never clobber a filled slot with an empty value", () => {
  it("fills empty slots from updates", () => {
    const merged = mergeSlots({}, { issueType: "water_leak", address: "1 Main St" });
    expect(merged.issueType).toBe("water_leak");
    expect(merged.address).toBe("1 Main St");
  });

  it("does NOT overwrite a filled slot with null/undefined/empty (review H2)", () => {
    const known = { issueType: "heating_not_working", address: "1 Main St" } as const;
    const merged = mergeSlots(known, {
      issueType: null,
      address: undefined,
    });
    expect(merged.issueType).toBe("heating_not_working");
    expect(merged.address).toBe("1 Main St");
  });

  it("overwrites a filled slot with a new non-empty value", () => {
    const merged = mergeSlots({ urgency: "low" }, { urgency: "emergency" });
    expect(merged.urgency).toBe("emergency");
  });

  it("treats empty string as not-filled (does not clobber)", () => {
    const merged = mergeSlots({ address: "1 Main St" }, { address: "" });
    expect(merged.address).toBe("1 Main St");
  });
});

describe("hasSlotData", () => {
  it("is false when nothing is filled", () => {
    expect(hasSlotData({})).toBe(false);
    expect(hasSlotData({ issueType: null, address: null })).toBe(false);
  });
  it("is true when any slot is filled", () => {
    expect(hasSlotData({ issueType: "maintenance" })).toBe(true);
    expect(hasSlotData({ phone: "555-1234" })).toBe(true);
  });
});

describe("buildExtraction", () => {
  it("maps slots to the ExtractionResult shape", () => {
    const e = buildExtraction(
      {
        issueType: "cooling_not_working",
        urgency: "high",
        address: "1 Main St",
        name: "Jane",
        phone: "555-1234",
        email: "j@x.com",
      },
      "AC blowing warm air",
    );
    expect(e).toEqual({
      issueType: "cooling_not_working",
      urgency: "high",
      address: "1 Main St",
      customerName: "Jane",
      customerPhone: "555-1234",
      customerEmail: "j@x.com",
      description: "AC blowing warm air",
      isHvacRelated: true,
    });
  });

  it("falls back to a non-empty description and nulls for missing slots", () => {
    const e = buildExtraction({}, "");
    expect(e.description.length).toBeGreaterThan(0);
    expect(e.issueType).toBeNull();
    expect(e.customerName).toBeNull();
    expect(e.isHvacRelated).toBe(true);
  });
});
