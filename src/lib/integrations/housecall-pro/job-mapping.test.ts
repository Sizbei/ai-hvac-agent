import { describe, it, expect } from "vitest";
import {
  serviceRequestToJobFields,
  type RequestJobInput,
} from "./job-mapping";

const BASE: RequestJobInput = {
  referenceNumber: "HVAC-ABCD1234",
  issueType: "No cooling",
  urgency: "high",
  description: "Upstairs unit blowing warm air",
  jobType: "no_cool",
  systemType: "central_ac",
  arrivalWindowStart: new Date("2026-07-01T12:00:00.000Z"),
  arrivalWindowEnd: new Date("2026-07-01T16:00:00.000Z"),
  addressText: "1 Main St, Boston MA",
  accessNotes: "Gate code 1234, beware of dog",
};

describe("serviceRequestToJobFields", () => {
  it("emits the labelled description lines for present fields", () => {
    const { description } = serviceRequestToJobFields(BASE);
    expect(description).toContain("Reference: HVAC-ABCD1234");
    expect(description).toContain("Issue: No cooling");
    expect(description).toContain("Urgency: high");
    expect(description).toContain("Details: Upstairs unit blowing warm air");
    expect(description).toContain("Address: 1 Main St, Boston MA");
    expect(description).toContain("Access: Gate code 1234, beware of dog");
  });

  it("includes an ISO-UTC schedule when both window bounds are present", () => {
    const fields = serviceRequestToJobFields(BASE);
    expect(fields.scheduleStart).toBe("2026-07-01T12:00:00.000Z");
    expect(fields.scheduleEnd).toBe("2026-07-01T16:00:00.000Z");
  });

  it("omits the schedule for an unscheduled request (no window)", () => {
    const fields = serviceRequestToJobFields({
      ...BASE,
      arrivalWindowStart: null,
      arrivalWindowEnd: null,
    });
    expect(fields.scheduleStart).toBeUndefined();
    expect(fields.scheduleEnd).toBeUndefined();
    // Description is still produced.
    expect(fields.description).toContain("Reference: HVAC-ABCD1234");
  });

  it("omits a line when its value is absent (no empty Access:/Address:)", () => {
    const { description } = serviceRequestToJobFields({
      ...BASE,
      addressText: null,
      accessNotes: "   ",
    });
    expect(description).not.toContain("Address:");
    expect(description).not.toContain("Access:");
  });

  it("includes descriptive line items derived from the intake (no prices)", () => {
    const { lineItems } = serviceRequestToJobFields(BASE);
    expect(lineItems).toBeDefined();
    expect(lineItems?.length).toBeGreaterThan(0);
    expect(lineItems?.some((i) => i.name === "No Cool — No cooling")).toBe(true);
    expect(lineItems?.some((i) => i.name === "Central Ac service")).toBe(true);
    for (const item of lineItems ?? []) {
      expect(item.unitPriceCents).toBeUndefined();
    }
  });

  it("omits lineItems when nothing could be derived", () => {
    const { lineItems } = serviceRequestToJobFields({
      ...BASE,
      issueType: "   ",
      jobType: null,
      systemType: null,
      accessNotes: null,
    });
    expect(lineItems).toBeUndefined();
  });
});
