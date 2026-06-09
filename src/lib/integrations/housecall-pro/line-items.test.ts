import { describe, it, expect } from "vitest";
import {
  buildLineItemsFromRequest,
  type LineItemSource,
} from "./line-items";

const BASE: LineItemSource = {
  issueType: "No cooling",
  jobType: "no_cool",
  systemType: "central_ac",
  accessNotes: "Gate code 1234, beware of dog",
};

describe("buildLineItemsFromRequest", () => {
  it("derives a service line from jobType + issueType (humanized, qualified)", () => {
    const items = buildLineItemsFromRequest(BASE);
    const service = items.find((i) => i.kind === "service");
    expect(service?.name).toBe("No Cool — No cooling");
    expect(service?.quantity).toBe(1);
  });

  it("derives a system service line from systemType", () => {
    const items = buildLineItemsFromRequest(BASE);
    const system = items.find((i) => i.name === "Central Ac service");
    expect(system).toBeDefined();
    expect(system?.kind).toBe("service");
  });

  it("derives an access (labor) line carrying the access notes", () => {
    const items = buildLineItemsFromRequest(BASE);
    const access = items.find((i) => i.kind === "labor");
    expect(access?.name).toBe("Site access");
    expect(access?.description).toBe("Gate code 1234, beware of dog");
  });

  it("NEVER sets a price on any derived item", () => {
    const items = buildLineItemsFromRequest(BASE);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.unitPriceCents).toBeUndefined();
    }
  });

  it("falls back to a 'Service Call — <symptom>' line when jobType is absent", () => {
    const items = buildLineItemsFromRequest({
      ...BASE,
      jobType: null,
      systemType: null,
      accessNotes: null,
    });
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Service Call — No cooling");
    expect(items[0].kind).toBe("service");
    expect(items[0].unitPriceCents).toBeUndefined();
  });

  it("handles a partial intake (only systemType known)", () => {
    const items = buildLineItemsFromRequest({
      issueType: "",
      jobType: null,
      systemType: "heat_pump",
      accessNotes: "   ",
    });
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Heat Pump service");
  });

  it("omits the access line when access notes are blank/whitespace", () => {
    const items = buildLineItemsFromRequest({ ...BASE, accessNotes: "   " });
    expect(items.some((i) => i.kind === "labor")).toBe(false);
  });

  it("returns an empty array when nothing is known (caller omits lineItems)", () => {
    const items = buildLineItemsFromRequest({
      issueType: "   ",
      jobType: null,
      systemType: null,
      accessNotes: null,
    });
    expect(items).toEqual([]);
  });

  it("uses a plain 'Service Call' label when only jobType service_call is known", () => {
    const items = buildLineItemsFromRequest({
      issueType: "",
      jobType: "service_call",
      systemType: null,
      accessNotes: null,
    });
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Service Call");
  });
});
