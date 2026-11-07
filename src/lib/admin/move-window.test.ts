import { describe, it, expect } from "vitest";
import {
  covers, currentWindowKind, keepWindowOn, namedWindowOf, promptPlan, resolveMoveWindow, timeOffHits, windowHasEndedAt,
  type TimeWindow,
} from "./move-window";
import type { BoardBlock } from "./board-types";

// 2026-11-10 is a Tuesday in EST (UTC-5): 9 AM = 14:00Z.
const D = "2026-11-10";
const w = (start: string, end: string): TimeWindow => ({ start: new Date(start), end: new Date(end) });
const NINE_ELEVEN = w("2026-11-10T14:00:00.000Z", "2026-11-10T16:00:00.000Z");
const MORNING = w("2026-11-10T13:00:00.000Z", "2026-11-10T17:00:00.000Z");
const ANYTIME = w("2026-11-10T13:00:00.000Z", "2026-11-11T01:00:00.000Z");
const ELEVEN_ONE = w("2026-11-10T16:00:00.000Z", "2026-11-10T18:00:00.000Z");
const SEVEN_NINE = w("2026-11-10T12:00:00.000Z", "2026-11-10T14:00:00.000Z");
const iso = (t: TimeWindow) => [t.start.toISOString(), t.end.toISOString()];

describe("namedWindowOf / currentWindowKind", () => {
  it("names the exact bands on the start's business day", () => {
    expect(namedWindowOf(MORNING.start, MORNING.end)).toBe("morning");
    expect(namedWindowOf(new Date("2026-11-10T21:00:00.000Z"), new Date("2026-11-11T01:00:00.000Z"))).toBe("evening");
    expect(namedWindowOf(ANYTIME.start, ANYTIME.end)).toBe("anytime");
    expect(namedWindowOf(NINE_ELEVEN.start, NINE_ELEVEN.end)).toBeNull();
  });
  it("band | anytime | custom | none", () => {
    expect(currentWindowKind(MORNING.start, MORNING.end)).toBe("band");
    expect(currentWindowKind(ANYTIME.start, ANYTIME.end)).toBe("anytime");
    expect(currentWindowKind(NINE_ELEVEN.start, NINE_ELEVEN.end)).toBe("custom");
    expect(currentWindowKind(null, null)).toBe("none");
    expect(currentWindowKind(MORNING.start, null)).toBe("none");
  });
});

describe("keepWindowOn", () => {
  it("keeps the wall-clock times on another day", () => {
    expect(iso(keepWindowOn(NINE_ELEVEN, "2026-11-11"))).toEqual(["2026-11-11T14:00:00.000Z", "2026-11-11T16:00:00.000Z"]);
  });
  it("keep keeps an end past midnight on D + 1", () => {
    const late = w("2026-11-11T04:00:00.000Z", "2026-11-11T06:00:00.000Z"); // 11 PM–1 AM from Nov 10
    expect(iso(keepWindowOn(late, "2026-11-12"))).toEqual(["2026-11-13T04:00:00.000Z", "2026-11-13T06:00:00.000Z"]);
  });
  it("keep across the 2027-03-14 DST start stays 9–11 Eastern", () => {
    const before = w("2027-03-13T14:00:00.000Z", "2027-03-13T16:00:00.000Z"); // 9–11 EST
    expect(iso(keepWindowOn(before, "2027-03-14"))).toEqual(["2027-03-14T13:00:00.000Z", "2027-03-14T15:00:00.000Z"]); // 9–11 EDT
  });
});

describe("covers (half-open, the window moved onto the drop day)", () => {
  it("anytime covers every band", () => {
    for (const b of ["morning", "afternoon", "evening"] as const) expect(covers(ANYTIME, D, b)).toBe(true);
  });
  it("11–1 covers morning and afternoon, not evening", () => {
    expect(covers(ELEVEN_ONE, D, "morning")).toBe(true);
    expect(covers(ELEVEN_ONE, D, "afternoon")).toBe(true);
    expect(covers(ELEVEN_ONE, D, "evening")).toBe(false);
  });
  it("7–9 covers morning only", () => {
    expect(covers(SEVEN_NINE, D, "morning")).toBe(true);
    expect(covers(SEVEN_NINE, D, "afternoon")).toBe(false);
  });
  it("a window ending exactly where a band starts doesn't cover it", () => {
    expect(covers(MORNING, D, "afternoon")).toBe(false);
  });
  it("is evaluated on the drop day", () => {
    expect(covers(NINE_ELEVEN, "2026-11-11", "morning")).toBe(true);
  });
  it("no window covers nothing", () => {
    expect(covers(null, D, "morning")).toBe(false);
  });
});

describe("promptPlan (spec §5.2)", () => {
  it("Unscheduled (no window) → use the band, no prompt", () => {
    expect(promptPlan(null, D, "afternoon", true)).toEqual({ kind: "use_band" });
  });
  it("a covered lane change never prompts: keep", () => {
    expect(promptPlan(NINE_ELEVEN, D, "morning", true)).toEqual({ kind: "keep" });
    expect(promptPlan(ANYTIME, D, "afternoon", true)).toEqual({ kind: "keep" });
    expect(promptPlan(ELEVEN_ONE, D, "afternoon", true)).toEqual({ kind: "keep" });
    expect(promptPlan(SEVEN_NINE, D, "morning", true)).toEqual({ kind: "keep" });
  });
  it("a covered day change keeps the window too", () => {
    expect(promptPlan(NINE_ELEVEN, "2026-11-11", "morning", false)).toEqual({ kind: "keep" });
  });
  it("same lane and day, band equal to the window → noop without the covered line", () => {
    expect(promptPlan(MORNING, D, "morning", false)).toEqual({ kind: "noop", coveredLine: false });
  });
  it("same lane and day, a band the window only overlaps → noop with the covered line", () => {
    expect(promptPlan(ANYTIME, D, "afternoon", false)).toEqual({ kind: "noop", coveredLine: true });
  });
  it("same day and lead: Keep isn't offered, default Use the new window", () => {
    expect(promptPlan(NINE_ELEVEN, D, "afternoon", false)).toEqual({ kind: "prompt", defaultChoice: "match", offerKeep: false });
  });
  it("crossing defaults: a band window → Use the new window; custom → Keep", () => {
    expect(promptPlan(MORNING, D, "afternoon", true)).toEqual({ kind: "prompt", defaultChoice: "match", offerKeep: true });
    expect(promptPlan(NINE_ELEVEN, D, "afternoon", true)).toEqual({ kind: "prompt", defaultChoice: "keep", offerKeep: true });
    expect(promptPlan(ELEVEN_ONE, D, "evening", true)).toEqual({ kind: "prompt", defaultChoice: "keep", offerKeep: true });
    expect(promptPlan(SEVEN_NINE, "2026-11-11", "afternoon", false)).toEqual({ kind: "prompt", defaultChoice: "keep", offerKeep: true });
  });
});

describe("resolveMoveWindow", () => {
  it("match → the drop band on the drop day", () => {
    expect(resolveMoveWindow(NINE_ELEVEN, D, "afternoon", "match")).toEqual({ ok: true, start: new Date("2026-11-10T17:00:00.000Z"), end: new Date("2026-11-10T21:00:00.000Z") });
  });
  it("pick → the named window on the drop day (anytime included)", () => {
    expect(resolveMoveWindow(NINE_ELEVEN, "2026-11-11", "morning", "pick", "anytime")).toEqual({ ok: true, start: new Date("2026-11-11T13:00:00.000Z"), end: new Date("2026-11-12T01:00:00.000Z") });
  });
  it("pick without a pick is not ok", () => {
    expect(resolveMoveWindow(NINE_ELEVEN, D, "morning", "pick")).toEqual({ ok: false });
  });
  it("keep → the same wall-clock times on the drop day", () => {
    expect(resolveMoveWindow(NINE_ELEVEN, "2026-11-12", "evening", "keep")).toEqual({ ok: true, start: new Date("2026-11-12T14:00:00.000Z"), end: new Date("2026-11-12T16:00:00.000Z") });
  });
  it("keep without a window is not ok (the route answers 400 windowRule)", () => {
    expect(resolveMoveWindow(null, D, "morning", "keep")).toEqual({ ok: false });
  });
});

describe("windowHasEndedAt", () => {
  it("ended once the end is at or before now", () => {
    expect(windowHasEndedAt(MORNING, new Date("2026-11-10T17:00:00.000Z"))).toBe(true);
    expect(windowHasEndedAt(MORNING, new Date("2026-11-10T16:59:59.000Z"))).toBe(false);
  });
});

describe("timeOffHits", () => {
  const block = (over: Partial<BoardBlock>): BoardBlock => ({
    id: "s1", technicianId: "sam", kind: "time_off", title: null,
    startsAt: "2026-11-10T21:00:00.000Z", endsAt: "2026-11-11T01:00:00.000Z", removesCapacity: true, ...over,
  });
  const EVENING = w("2026-11-10T21:00:00.000Z", "2026-11-11T01:00:00.000Z");
  it("hits a capacity-removing block of a checked technician that overlaps", () => {
    expect(timeOffHits([block({})], ["sam"], EVENING).map((b) => b.id)).toEqual(["s1"]);
  });
  it("ignores blocks that keep capacity, whatever the kind", () => {
    expect(timeOffHits([block({ kind: "on_call", removesCapacity: false }), block({ id: "s2", kind: "non_job", removesCapacity: false })], ["sam"], EVENING)).toEqual([]);
  });
  it("a capacity-removing on_call still hits", () => {
    expect(timeOffHits([block({ kind: "on_call", removesCapacity: true })], ["sam"], EVENING)).toHaveLength(1);
  });
  it("ignores technicians the move doesn't check, and touching edges", () => {
    expect(timeOffHits([block({})], ["alex"], EVENING)).toEqual([]);
    expect(timeOffHits([block({})], ["sam"], w("2026-11-10T17:00:00.000Z", "2026-11-10T21:00:00.000Z"))).toEqual([]);
  });
});
