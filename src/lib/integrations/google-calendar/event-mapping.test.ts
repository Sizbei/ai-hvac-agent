import { describe, it, expect } from "vitest";
import {
  serviceRequestToGoogleEvent,
  toEasternEventDateTime,
  type RequestEventInput,
} from "./event-mapping";

function baseInput(
  overrides: Partial<RequestEventInput> = {},
): RequestEventInput {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    referenceNumber: "REQ-0042",
    issueType: "No cooling",
    urgency: "high",
    description: "AC stopped working overnight",
    // 2026-07-01 12:00 UTC → summer (EDT, UTC-4) → 08:00 Eastern.
    arrivalWindowStart: new Date("2026-07-01T12:00:00Z"),
    arrivalWindowEnd: new Date("2026-07-01T16:00:00Z"),
    customerName: "Jane Doe",
    customerPhone: "+15551234567",
    addressText: "12 Main St",
    accessNotes: "Gate code 4321",
    assignedToName: "Tech Bob",
    ...overrides,
  };
}

describe("toEasternEventDateTime", () => {
  it("renders a summer UTC instant as Eastern wall-clock (EDT) with no offset", () => {
    const dt = toEasternEventDateTime(new Date("2026-07-01T12:00:00Z"));
    expect(dt.dateTime).toBe("2026-07-01T08:00:00");
    expect(dt.timeZone).toBe("America/New_York");
  });

  it("renders a winter UTC instant as Eastern wall-clock (EST), DST-correct", () => {
    // 2026-01-15 13:00 UTC → winter (EST, UTC-5) → 08:00 Eastern.
    const dt = toEasternEventDateTime(new Date("2026-01-15T13:00:00Z"));
    expect(dt.dateTime).toBe("2026-01-15T08:00:00");
    expect(dt.timeZone).toBe("America/New_York");
  });

  it("never embeds a UTC offset in the dateTime string", () => {
    const dt = toEasternEventDateTime(new Date("2026-07-01T12:00:00Z"));
    expect(dt.dateTime).not.toMatch(/[zZ]|[+-]\d{2}:\d{2}$/);
  });
});

describe("serviceRequestToGoogleEvent", () => {
  it("maps start/end to Eastern times with the IANA timezone", () => {
    const event = serviceRequestToGoogleEvent(baseInput());
    expect(event.start).toEqual({
      dateTime: "2026-07-01T08:00:00",
      timeZone: "America/New_York",
    });
    expect(event.end).toEqual({
      dateTime: "2026-07-01T12:00:00",
      timeZone: "America/New_York",
    });
  });

  it("uses the request id as the idempotency key in extendedProperties", () => {
    const event = serviceRequestToGoogleEvent(baseInput());
    expect(event.extendedProperties.private.requestId).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("builds a customer + issue summary", () => {
    const event = serviceRequestToGoogleEvent(baseInput());
    expect(event.summary).toBe("Jane Doe — No cooling");
  });

  it("falls back to a generic summary when the customer name is absent", () => {
    const event = serviceRequestToGoogleEvent(
      baseInput({ customerName: null }),
    );
    expect(event.summary).toBe("HVAC service — No cooling");
  });

  it("includes reference, phone, address, and access notes in the description", () => {
    const event = serviceRequestToGoogleEvent(baseInput());
    expect(event.description).toContain("Reference: REQ-0042");
    expect(event.description).toContain("Phone: +15551234567");
    expect(event.description).toContain("Address: 12 Main St");
    expect(event.description).toContain("Access: Gate code 4321");
    expect(event.description).toContain("Technician: Tech Bob");
  });

  it("omits PII lines that are null rather than emitting empty labels", () => {
    const event = serviceRequestToGoogleEvent(
      baseInput({
        customerPhone: null,
        addressText: null,
        accessNotes: null,
        assignedToName: null,
      }),
    );
    expect(event.description).not.toContain("Phone:");
    expect(event.description).not.toContain("Address:");
    expect(event.description).not.toContain("Access:");
    expect(event.description).not.toContain("Technician:");
    // Non-PII fields still present.
    expect(event.description).toContain("Reference: REQ-0042");
  });
});
