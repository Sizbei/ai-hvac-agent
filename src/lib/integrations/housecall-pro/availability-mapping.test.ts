import { describe, it, expect } from "vitest";
import {
  mapHcpAvailability,
  HCP_SYNTHETIC_TECH_PREFIX,
} from "./availability-mapping";
import { businessWallClockToUtc } from "@/lib/admin/calendar-time";
import type { HousecallAvailabilitySlot } from "./types";

/** Build an HCP window from Eastern wall-clock bounds on a business day. */
function win(
  isoDay: string,
  startHour: number,
  endHour: number,
): HousecallAvailabilitySlot {
  return {
    startIso: businessWallClockToUtc(isoDay, startHour, 0).toISOString(),
    endIso: businessWallClockToUtc(isoDay, endHour, 0).toISOString(),
  };
}

describe("mapHcpAvailability", () => {
  it("maps each HCP window to its own synthetic technician + recurring slot", () => {
    // 2026-07-01 is a Wednesday (dayOfWeek 3).
    const result = mapHcpAvailability([
      win("2026-07-01", 8, 12),
      win("2026-07-01", 13, 17),
    ]);

    expect(result.slots).toHaveLength(2);
    expect(result.technicianIds).toHaveLength(2);
    // Distinct synthetic techs, each with the prefix (no real HCP staff id).
    expect(new Set(result.technicianIds).size).toBe(2);
    expect(
      result.technicianIds.every((id) =>
        id.startsWith(HCP_SYNTHETIC_TECH_PREFIX),
      ),
    ).toBe(true);

    const first = result.slots[0]!;
    expect(first.dayOfWeek).toBe(3); // Wednesday, business-tz
    expect(first.startMinute).toBe(8 * 60);
    expect(first.endMinute).toBe(12 * 60);
    expect(first.technicianId).toBe(result.technicianIds[0]);
  });

  it("reads weekday + minutes in the BUSINESS timezone, not UTC", () => {
    // An 8 AM–12 PM Eastern window in summer (EDT, UTC-4) is 12:00–16:00 UTC.
    // The mapping must report Eastern minutes (480..720), never UTC (720..960).
    const result = mapHcpAvailability([win("2026-07-01", 8, 12)]);
    const slot = result.slots[0]!;
    expect(slot.startMinute).toBe(8 * 60);
    expect(slot.endMinute).toBe(12 * 60);
  });

  it("drops malformed windows rather than throwing", () => {
    const result = mapHcpAvailability([
      { startIso: "not-a-date", endIso: "also-bad" },
      win("2026-07-01", 8, 12),
    ]);
    expect(result.slots).toHaveLength(1);
    expect(result.technicianIds).toHaveLength(1);
  });

  it("drops a zero/negative-span window", () => {
    const result = mapHcpAvailability([win("2026-07-01", 10, 10)]);
    expect(result.slots).toHaveLength(0);
  });

  it("returns an empty surface for an empty window list", () => {
    expect(mapHcpAvailability([])).toEqual({ slots: [], technicianIds: [] });
  });
});
