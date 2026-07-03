import { describe, it, expect } from "vitest";
import {
  parseKnownSlots,
  mergeSlots,
  hasSlotData,
  buildExtraction,
  parseUrgencyAnswer,
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
      extras: {},
    });
  });

  it("carries the ServiceTitan-style extras through parse and round-trips", () => {
    const meta = JSON.stringify({
      issueType: "cooling_not_working",
      urgency: "high",
      address: "5 Oak St",
      customerPhone: "555-1234",
      description: "AC out",
      isHvacRelated: true,
      systemType: "heat_pump",
      preferredWindow: "morning",
      vulnerableOccupants: true,
    });
    const slots = parseKnownSlots(meta);
    expect(slots.extras).toEqual({
      systemType: "heat_pump",
      preferredWindow: "morning",
      vulnerableOccupants: true,
    });
  });

  it("mergeSlots never clobbers a filled extra with an empty update", () => {
    const known = parseKnownSlots(
      JSON.stringify({ systemType: "furnace", description: "x", isHvacRelated: true }),
    );
    const merged = mergeSlots(known, { extras: { systemType: null, preferredWindow: "asap" } });
    expect(merged.extras).toEqual({ systemType: "furnace", preferredWindow: "asap" });
  });

  it("buildExtraction spreads extras back into the metadata shape", () => {
    const slots = mergeSlots(
      {},
      {
        issueType: "cooling_not_working",
        extras: { systemType: "central_ac", leadSource: "google" },
      },
    );
    const e = buildExtraction(slots, "AC out");
    expect(e.systemType).toBe("central_ac");
    expect(e.leadSource).toBe("google");
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

  it("sanitizes contact fields (name caps, phone format, address tidy, email lower)", () => {
    const e = buildExtraction(
      {
        name: "brian hoang",
        phone: "5551234567",
        address: "12 oak st  ,knoxville tn 37920",
        email: " B@X.COM ",
      },
      "AC out",
    );
    expect(e.customerName).toBe("Brian Hoang");
    expect(e.customerPhone).toBe("(555) 123-4567");
    expect(e.address).toBe("12 Oak St, Knoxville TN 37920");
    expect(e.customerEmail).toBe("b@x.com");
  });
});

describe("stripSkipSentinels", () => {
  it("drops __skipped__ values, preserves real ones, and handles empty input", async () => {
    const { stripSkipSentinels, SKIP_SENTINEL } = await import("./chat-slots");
    expect(
      stripSkipSentinels({
        systemType: "heat_pump",
        equipmentBrand: SKIP_SENTINEL,
        preferredWindow: "morning",
      }),
    ).toEqual({ systemType: "heat_pump", preferredWindow: "morning" });
    expect(stripSkipSentinels({})).toEqual({});
  });
});

describe("parseUrgencyAnswer — negated urgency (audit HIGH #13)", () => {
  it("reads negated phrasings as low, not urgent/emergency", () => {
    expect(parseUrgencyAnswer("it's not an emergency")).toBe("low");
    expect(parseUrgencyAnswer("not urgent")).toBe("low");
    expect(parseUrgencyAnswer("isn’t urgent")).toBe("low"); // curly apostrophe (#37)
    expect(parseUrgencyAnswer("no rush")).toBe("low");
  });
  it("still reads a genuine emergency as emergency", () => {
    expect(parseUrgencyAnswer("it's an emergency")).toBe("emergency");
    expect(parseUrgencyAnswer("asap")).toBe("emergency");
  });
});
