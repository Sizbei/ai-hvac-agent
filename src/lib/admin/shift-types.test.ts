import { describe, it, expect } from "vitest";
import {
  defaultRemovesCapacity,
  shiftInputSchema,
  shiftBatchInputSchema,
  blocksToScheduledJobs,
  excludeTechniciansWithBlocks,
  blocksCoveringSpan,
  hasTimeOff,
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

describe("shiftBatchInputSchema", () => {
  const day = (d: number) => ({
    startsAt: `2026-11-${String(d).padStart(2, "0")}T13:00:00.000Z`,
    endsAt: `2026-11-${String(d).padStart(2, "0")}T22:00:00.000Z`,
  });
  it("accepts 1 to 31 spans and defaults removesCapacity by kind", () => {
    const one = shiftBatchInputSchema.parse({ kind: "time_off", spans: [day(2)] });
    expect(one.removesCapacity).toBe(true);
    expect(one.spans).toHaveLength(1);
    const many = Array.from({ length: 31 }, (_, i) => ({ startsAt: new Date(Date.parse(base.startsAt) + i * 86_400_000).toISOString(), endsAt: new Date(Date.parse(base.endsAt) + i * 86_400_000).toISOString() }));
    expect(shiftBatchInputSchema.parse({ kind: "on_call", spans: many }).removesCapacity).toBe(false);
  });
  it("rejects no spans or more than 31", () => {
    expect(shiftBatchInputSchema.safeParse({ kind: "time_off", spans: [] }).success).toBe(false);
    expect(shiftBatchInputSchema.safeParse({ kind: "time_off", spans: Array.from({ length: 32 }, () => day(2)) }).success).toBe(false);
  });
  it("applies the single-shift rules to every span", () => {
    expect(shiftBatchInputSchema.safeParse({ kind: "time_off", spans: [day(2), { startsAt: day(3).endsAt, endsAt: day(3).startsAt }] }).success).toBe(false);
    expect(shiftBatchInputSchema.safeParse({ kind: "time_off", spans: [{ startsAt: "2026-11-01T00:00:00.000Z", endsAt: "2026-12-03T00:00:00.000Z" }] }).success).toBe(false);
    expect(shiftBatchInputSchema.safeParse({ kind: "time_off", spans: [{ startsAt: "nope", endsAt: day(2).endsAt }] }).success).toBe(false);
  });
});

const rec = (over: Partial<ShiftRecord>): ShiftRecord => ({
  id: "s1", technicianId: "t1", kind: "time_off", title: null, ...base, removesCapacity: true, ...over,
});

describe("blocksToScheduledJobs", () => {
  it("maps rows to scheduled jobs", () => {
    expect(blocksToScheduledJobs([rec({}), rec({ id: "s2", technicianId: "t2", title: "Training" })])).toEqual([
      { id: "s1", referenceNumber: "Time off", status: "assigned", assignedTo: "t1", arrivalWindowStart: base.startsAt, arrivalWindowEnd: base.endsAt, timeOff: true },
      { id: "s2", referenceNumber: "Training", status: "assigned", assignedTo: "t2", arrivalWindowStart: base.startsAt, arrivalWindowEnd: base.endsAt, timeOff: true },
    ]);
  });
  it("labels untitled shifts by kind", () => {
    const out = blocksToScheduledJobs([
      rec({ id: "a", kind: "time_off" }),
      rec({ id: "b", kind: "on_call" }),
      rec({ id: "c", kind: "non_job" }),
    ]);
    expect(out.map((j) => j.referenceNumber)).toEqual(["Time off", "On call", "Non-job event"]);
  });
});

describe("hasTimeOff", () => {
  const job = { id: "j", referenceNumber: "R-1", status: "assigned", assignedTo: "t1", arrivalWindowStart: base.startsAt, arrivalWindowEnd: base.endsAt };
  it("is false for an empty list or plain jobs", () => {
    expect(hasTimeOff([])).toBe(false);
    expect(hasTimeOff([job])).toBe(false);
  });
  it("is true when any entry is time off", () => {
    expect(hasTimeOff([job, ...blocksToScheduledJobs([rec({})])])).toBe(true);
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
