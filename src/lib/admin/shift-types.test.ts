import { describe, it, expect } from "vitest";
import {
  defaultRemovesCapacity,
  shiftInputSchema,
  blocksToScheduledJobs,
  excludeTechniciansWithBlocks,
  blocksCoveringSpan,
  type ShiftRecord,
} from "./shift-types";

const base = { startsAt: "2026-11-02T13:00:00.000Z", endsAt: "2026-11-02T22:00:00.000Z" };

describe("defaultRemovesCapacity", () => {
  it("is false only for on_call", () => {
    expect(defaultRemovesCapacity("on_call")).toBe(false);
    expect(defaultRemovesCapacity("time_off")).toBe(true);
    expect(defaultRemovesCapacity("non_job")).toBe(true);
  });
});

describe("shiftInputSchema", () => {
  it("rejects end before or equal to start", () => {
    expect(shiftInputSchema.safeParse({ kind: "time_off", startsAt: base.endsAt, endsAt: base.startsAt }).success).toBe(false);
    expect(shiftInputSchema.safeParse({ kind: "time_off", startsAt: base.startsAt, endsAt: base.startsAt }).success).toBe(false);
  });
  it("rejects spans over 31 days", () => {
    expect(shiftInputSchema.safeParse({ kind: "time_off", startsAt: "2026-11-01T00:00:00.000Z", endsAt: "2026-12-03T00:00:00.000Z" }).success).toBe(false);
  });
  it("accepts exactly 31 days", () => {
    expect(shiftInputSchema.safeParse({ kind: "time_off", startsAt: "2026-11-01T00:00:00.000Z", endsAt: "2026-12-02T00:00:00.000Z" }).success).toBe(true);
  });
  it("defaults removesCapacity by kind", () => {
    const onCall = shiftInputSchema.parse({ kind: "on_call", ...base });
    const timeOff = shiftInputSchema.parse({ kind: "time_off", ...base });
    expect(onCall.removesCapacity).toBe(false);
    expect(timeOff.removesCapacity).toBe(true);
  });
  it("keeps an explicit removesCapacity and rejects long titles", () => {
    expect(shiftInputSchema.parse({ kind: "on_call", removesCapacity: true, ...base }).removesCapacity).toBe(true);
    expect(shiftInputSchema.safeParse({ kind: "non_job", title: "x".repeat(81), ...base }).success).toBe(false);
  });
});

const rec = (over: Partial<ShiftRecord>): ShiftRecord => ({
  id: "s1", technicianId: "t1", kind: "time_off", title: null, ...base, removesCapacity: true, ...over,
});

describe("blocksToScheduledJobs", () => {
  it("maps rows to scheduled jobs", () => {
    expect(blocksToScheduledJobs([rec({}), rec({ id: "s2", technicianId: "t2", title: "Training" })])).toEqual([
      { id: "s1", referenceNumber: "Time off", status: "assigned", assignedTo: "t1", arrivalWindowStart: base.startsAt, arrivalWindowEnd: base.endsAt },
      { id: "s2", referenceNumber: "Training", status: "assigned", assignedTo: "t2", arrivalWindowStart: base.startsAt, arrivalWindowEnd: base.endsAt },
    ]);
  });
});

describe("excludeTechniciansWithBlocks", () => {
  it("drops only blocked ids and keeps order", () => {
    const blocks = blocksToScheduledJobs([rec({ technicianId: "b" })]);
    expect(excludeTechniciansWithBlocks(["c", "b", "a"], blocks)).toEqual(["c", "a"]);
    expect(excludeTechniciansWithBlocks(["a"], [])).toEqual(["a"]);
  });
});

describe("blocksCoveringSpan", () => {
  it("keeps blocks covering the whole span and drops partial overlaps", () => {
    const blocks = blocksToScheduledJobs([
      rec({ id: "full", technicianId: "a" }),
      rec({ id: "part", technicianId: "b", endsAt: "2026-11-02T18:00:00.000Z" }),
    ]);
    const out = blocksCoveringSpan(
      blocks,
      new Date("2026-11-02T13:00:00.000Z"),
      new Date("2026-11-02T22:00:00.000Z"),
    );
    expect(out.map((b) => b.id)).toEqual(["full"]);
  });
});
