import { describe, it, expect } from "vitest";
import { classifyMassVisit, massChanges, massDayShift, massDefaultDay, type MassContext, type MassVisitFacts } from "./mass-reschedule-model";

const T = "t-alex";
const T2 = "t-sam";
const facts = (over: Partial<MassVisitFacts> = {}): MassVisitFacts => ({
  visitId: "v1", requestId: "r1", visitNumber: 1,
  window: { start: new Date("2026-11-10T14:00:00.000Z"), end: new Date("2026-11-10T16:00:00.000Z") },
  fieldpulse: false, techIsLead: true, ended: false,
  rows: [{ technicianId: T, isLead: true, status: "scheduled", hasTimestamp: false }],
  toTechOnVisit: false, ...over,
});
const ctx = (over: Partial<MassContext> = {}): MassContext => ({
  technicianId: T, toTechnicianId: T2, fromDate: "2026-11-10", toDate: "2026-11-11", now: new Date("2026-11-09T12:00:00.000Z"),
  blocks: [], busy: [], outsideHours: () => false, ...over,
});

describe("classifyMassVisit (order: fieldpulse, helper, later_visit, ended, started, window_ended, already_on_visit, time_off)", () => {
  it("moves, keeping wall-clock times on the new day", () => {
    const r = classifyMassVisit(facts(), ctx());
    expect(r.outcome).toBe("moves");
    expect(r.newWindow.start.toISOString()).toBe("2026-11-11T14:00:00.000Z");
  });
  it("each skip reason", () => {
    expect(classifyMassVisit(facts({ fieldpulse: true, techIsLead: false }), ctx()).outcome).toBe("fieldpulse");
    expect(classifyMassVisit(facts({ techIsLead: false }), ctx()).outcome).toBe("helper");
    expect(classifyMassVisit(facts({ visitNumber: 2 }), ctx()).outcome).toBe("later_visit");
    expect(classifyMassVisit(facts({ ended: true }), ctx()).outcome).toBe("ended");
    expect(classifyMassVisit(facts({ rows: [{ technicianId: T, isLead: true, status: "en_route", hasTimestamp: true }] }), ctx()).outcome).toBe("started");
    expect(classifyMassVisit(facts(), ctx({ now: new Date("2026-11-11T17:00:00.000Z") })).outcome).toBe("window_ended");
    expect(classifyMassVisit(facts({ toTechOnVisit: true }), ctx()).outcome).toBe("already_on_visit");
    expect(classifyMassVisit(facts(), ctx({ blocks: [{ id: "s", technicianId: T2, kind: "time_off", title: null, startsAt: "2026-11-11T13:00:00.000Z", endsAt: "2026-11-11T22:00:00.000Z", removesCapacity: true }] })).outcome).toBe("time_off");
  });
  it("time off is checked for T2 and, when the day changes, the crew who stays — never the old lead", () => {
    const offT = { id: "s", technicianId: T, kind: "time_off" as const, title: null, startsAt: "2026-11-11T13:00:00.000Z", endsAt: "2026-11-11T22:00:00.000Z", removesCapacity: true };
    expect(classifyMassVisit(facts(), ctx({ blocks: [offT] })).outcome).toBe("moves");
    expect(classifyMassVisit(facts(), ctx({ toTechnicianId: null, blocks: [offT] })).outcome).toBe("time_off");
  });
  it("a conflict is a soft flag on a move", () => {
    const busy = [{ technicianId: T2, requestId: "r9", start: new Date("2026-11-11T15:00:00.000Z"), end: new Date("2026-11-11T17:00:00.000Z") }];
    expect(classifyMassVisit(facts(), ctx({ busy }))).toMatchObject({ outcome: "moves", conflict: true });
    expect(classifyMassVisit(facts(), ctx({ outsideHours: (id) => id === T2 }))).toMatchObject({ outcome: "moves", conflict: true });
  });
  it("a request moving in the same run never conflicts (two shared-band visits both move)", () => {
    const busy = [{ technicianId: T2, requestId: "r2", start: new Date("2026-11-11T14:00:00.000Z"), end: new Date("2026-11-11T16:00:00.000Z") }];
    expect(classifyMassVisit(facts(), ctx({ busy })).conflict).toBe(true);
    expect(classifyMassVisit(facts(), ctx({ busy, batchRequestIds: ["r1", "r2"] })).conflict).toBe(false);
  });
  it("same-day lead swap: a non-moving request (T2 helps on it, so it is already_on_visit) still conflicts with Y", () => {
    const same = ctx({ toDate: "2026-11-10" });
    // X: T2 is a helper on it and it overlaps Y's window; it is skipped, so it is not in the moving set.
    const x = facts({ requestId: "rX", visitId: "vX", toTechOnVisit: true });
    expect(classifyMassVisit(x, same).outcome).toBe("already_on_visit");
    const busy = [{ technicianId: T2, requestId: "rX", start: new Date("2026-11-10T14:00:00.000Z"), end: new Date("2026-11-10T16:00:00.000Z") }];
    const y = facts({ requestId: "rY", visitId: "vY" });
    // The exclusion set is only the requests that move (Y), never X.
    expect(classifyMassVisit(y, { ...same, busy, batchRequestIds: ["rY"] })).toMatchObject({ outcome: "moves", conflict: true });
    // Building it from every wanted visit would wrongly hide the conflict.
    expect(classifyMassVisit(y, { ...same, busy, batchRequestIds: ["rX", "rY"] }).conflict).toBe(false);
  });
  it("its own request never conflicts", () => {
    const busy = [{ technicianId: T2, requestId: "r1", start: new Date("2026-11-11T15:00:00.000Z"), end: new Date("2026-11-11T17:00:00.000Z") }];
    expect(classifyMassVisit(facts(), ctx({ busy })).conflict).toBe(false);
  });
});

describe("days", () => {
  it("default to-day is the next weekday", () => {
    expect(massDefaultDay("2026-11-10")).toBe("2026-11-11"); // Tue → Wed
    expect(massDefaultDay("2026-11-13")).toBe("2026-11-16"); // Fri → Mon
    expect(massDefaultDay("2026-11-14")).toBe("2026-11-16"); // Sat → Mon
  });
  it("dayShift and whether anything changes", () => {
    expect(massDayShift("2026-11-10", "2026-11-12")).toBe(2);
    expect(massChanges({ fromDate: "2026-11-10", toDate: "2026-11-10", technicianId: T, toTechnicianId: null })).toBe(false);
    expect(massChanges({ fromDate: "2026-11-10", toDate: "2026-11-10", technicianId: T, toTechnicianId: T })).toBe(false);
    expect(massChanges({ fromDate: "2026-11-10", toDate: "2026-11-10", technicianId: T, toTechnicianId: T2 })).toBe(true);
  });
});
