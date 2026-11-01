import { describe, it, expect } from "vitest";
import {
  appointmentInputSchema,
  appointmentPatchSchema,
  nextAppointmentNumber,
  windowIsValid,
} from "./appointment-types";

const T = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const valid = {
  arrivalWindowStart: "2026-11-10T13:00:00Z",
  arrivalWindowEnd: "2026-11-10T17:00:00Z",
  technicianIds: [T(1)],
};

describe("nextAppointmentNumber", () => {
  it("starts at 2 when the request has no visits", () => {
    expect(nextAppointmentNumber([])).toBe(2);
  });
  it("is max + 1", () => {
    expect(nextAppointmentNumber([{ appointmentNumber: 1 }, { appointmentNumber: 2 }])).toBe(3);
    expect(nextAppointmentNumber([{ appointmentNumber: 4 }, { appointmentNumber: 1 }])).toBe(5);
  });
  it("never returns 1, even when only visit #1 exists", () => {
    expect(nextAppointmentNumber([{ appointmentNumber: 1 }])).toBe(2);
  });
});

describe("windowIsValid", () => {
  it("accepts end after start", () => {
    expect(windowIsValid("2026-11-10T13:00:00Z", "2026-11-10T17:00:00Z")).toBe(true);
  });
  it("rejects end equal to or before start", () => {
    expect(windowIsValid("2026-11-10T13:00:00Z", "2026-11-10T13:00:00Z")).toBe(false);
    expect(windowIsValid("2026-11-10T17:00:00Z", "2026-11-10T13:00:00Z")).toBe(false);
  });
  it("rejects unparseable dates", () => {
    expect(windowIsValid("nope", "2026-11-10T13:00:00Z")).toBe(false);
  });
});

describe("appointmentInputSchema", () => {
  it("accepts a valid visit", () => {
    expect(appointmentInputSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects more than 5 technicians and none", () => {
    expect(appointmentInputSchema.safeParse({ ...valid, technicianIds: [1, 2, 3, 4, 5, 6].map(T) }).success).toBe(false);
    expect(appointmentInputSchema.safeParse({ ...valid, technicianIds: [] }).success).toBe(false);
  });
  it("rejects an end before the start", () => {
    expect(appointmentInputSchema.safeParse({ ...valid, arrivalWindowEnd: "2026-11-10T12:00:00Z" }).success).toBe(false);
  });
  it("rejects non-uuid technician ids and over-long instructions", () => {
    expect(appointmentInputSchema.safeParse({ ...valid, technicianIds: ["x"] }).success).toBe(false);
    expect(appointmentInputSchema.safeParse({ ...valid, specialInstructions: "a".repeat(1001) }).success).toBe(false);
  });
});

describe("appointmentPatchSchema", () => {
  it("requires version", () => {
    expect(appointmentPatchSchema.safeParse(valid).success).toBe(false);
    expect(appointmentPatchSchema.safeParse({ ...valid, version: 0 }).success).toBe(true);
  });
  it("still rejects an end before the start", () => {
    expect(appointmentPatchSchema.safeParse({ ...valid, arrivalWindowEnd: "2026-11-10T12:00:00Z", version: 1 }).success).toBe(false);
  });
});
