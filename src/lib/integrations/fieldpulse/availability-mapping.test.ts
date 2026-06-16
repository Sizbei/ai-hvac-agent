/**
 * Tests for Fieldpulse availability mapping.
 *
 * The key regression guard: every slot must be derived from the ACTUAL Fieldpulse
 * window's UTC components — never the old hardcoded "Sunday 08:00–17:00"
 * placeholder. These tests also exercise the failure modes (malformed ISO,
 * reversed windows, missing fields) the mapper must drop rather than throw on.
 */
import { describe, it, expect } from "vitest";
import {
  mapFieldpulseAvailability,
  FIELDPULSE_AVAILABILITY_HORIZON_DAYS,
} from "./availability-mapping";
import type { FieldpulseAvailabilitySlot } from "./types";

describe("mapFieldpulseAvailability", () => {
  it("derives day-of-week and minutes from the real UTC window (NOT a placeholder)", () => {
    // 2026-01-07 is a Wednesday (UTC). 13:30 -> 810 min, 17:00 -> 1020 min.
    const result = mapFieldpulseAvailability([
      {
        startIso: "2026-01-07T13:30:00.000Z",
        endIso: "2026-01-07T17:00:00.000Z",
        userId: "u1",
      },
    ]);

    expect(result.slots).toHaveLength(1);
    const slot = result.slots[0]!;
    expect(slot.dayOfWeek).toBe(3); // Wednesday — proves it's not the Sunday(0) placeholder
    expect(slot.startMinute).toBe(810);
    expect(slot.endMinute).toBe(1020);
    expect(slot.technicianId).toBe("fp_u1");
    expect(result.technicanIds).toEqual(["fp_u1"]);
  });

  it("uses the fp_any synthetic id when no userId is present", () => {
    const result = mapFieldpulseAvailability([
      { startIso: "2026-01-05T08:00:00.000Z", endIso: "2026-01-05T12:00:00.000Z" },
    ]);
    expect(result.slots[0]!.technicianId).toBe("fp_any");
    expect(result.technicanIds).toEqual(["fp_any"]);
  });

  it("drops a slot missing startIso/endIso rather than throwing", () => {
    const slots = [
      { startIso: "", endIso: "2026-01-07T17:00:00.000Z" },
      { startIso: "2026-01-07T13:00:00.000Z", endIso: "" },
    ] as unknown as FieldpulseAvailabilitySlot[];
    expect(mapFieldpulseAvailability(slots).slots).toHaveLength(0);
  });

  it("drops a slot with an unparseable ISO timestamp", () => {
    const result = mapFieldpulseAvailability([
      { startIso: "not-a-date", endIso: "also-bad", userId: "u9" },
    ]);
    expect(result.slots).toHaveLength(0);
    expect(result.technicanIds).toHaveLength(0);
  });

  it("drops a reversed or zero-length window (start >= end)", () => {
    const result = mapFieldpulseAvailability([
      // end before start
      {
        startIso: "2026-01-07T17:00:00.000Z",
        endIso: "2026-01-07T09:00:00.000Z",
        userId: "u1",
      },
      // identical start/end
      {
        startIso: "2026-01-07T09:00:00.000Z",
        endIso: "2026-01-07T09:00:00.000Z",
        userId: "u2",
      },
    ]);
    expect(result.slots).toHaveLength(0);
  });

  it("deduplicates technician ids across multiple slots", () => {
    const result = mapFieldpulseAvailability([
      {
        startIso: "2026-01-05T08:00:00.000Z",
        endIso: "2026-01-05T12:00:00.000Z",
        userId: "u1",
      },
      {
        startIso: "2026-01-06T08:00:00.000Z",
        endIso: "2026-01-06T12:00:00.000Z",
        userId: "u1",
      },
    ]);
    expect(result.slots).toHaveLength(2);
    expect(result.technicanIds).toEqual(["fp_u1"]);
  });

  it("returns empty surfaces for empty input", () => {
    const result = mapFieldpulseAvailability([]);
    expect(result.slots).toEqual([]);
    expect(result.technicanIds).toEqual([]);
  });

  it("exposes a sane forward horizon constant", () => {
    expect(FIELDPULSE_AVAILABILITY_HORIZON_DAYS).toBeGreaterThan(0);
  });
});
