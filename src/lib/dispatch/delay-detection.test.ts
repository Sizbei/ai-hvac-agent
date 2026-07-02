import { describe, it, expect } from "vitest";
import { isArrivalLate } from "./delay-detection";

const windowEnd = new Date("2026-07-01T16:00:00Z"); // 4:00 PM
const GRACE = 15;

describe("isArrivalLate", () => {
  it("is late when the window passed by more than the grace and not started", () => {
    const now = windowEnd.getTime() + 20 * 60_000; // 20 min after
    expect(isArrivalLate({ status: "assigned", arrivalWindowEnd: windowEnd }, now, GRACE)).toBe(true);
    expect(isArrivalLate({ status: "scheduled", arrivalWindowEnd: windowEnd }, now, GRACE)).toBe(true);
  });

  it("is NOT late inside the grace buffer", () => {
    const now = windowEnd.getTime() + 10 * 60_000; // within 15-min grace
    expect(isArrivalLate({ status: "assigned", arrivalWindowEnd: windowEnd }, now, GRACE)).toBe(false);
  });

  it("is NOT late once the tech has started or finished", () => {
    const now = windowEnd.getTime() + 60 * 60_000;
    expect(isArrivalLate({ status: "in_progress", arrivalWindowEnd: windowEnd }, now, GRACE)).toBe(false);
    expect(isArrivalLate({ status: "completed", arrivalWindowEnd: windowEnd }, now, GRACE)).toBe(false);
  });

  it("is NOT late with no arrival window set", () => {
    const now = Date.now();
    expect(isArrivalLate({ status: "assigned", arrivalWindowEnd: null }, now, GRACE)).toBe(false);
  });
});
