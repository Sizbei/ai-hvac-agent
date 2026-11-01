import { describe, expect, it } from "vitest";
import type { TechAssignmentRow } from "@/lib/tech/ownership";
import type { RequestStatus } from "@/lib/admin/request-status";
import {
  TECH_ACTIONS,
  allowedActions,
  closeOutAllowedStatuses,
  resolveTechAction,
  type ResolveInput,
  type TechAction,
} from "@/lib/tech/status-actions";

const T = new Date("2026-11-01T10:00:00Z");

function row(over: Partial<TechAssignmentRow> = {}): TechAssignmentRow {
  return {
    assignmentId: "as1",
    appointmentId: "v1",
    appointmentNumber: 1,
    isLead: true,
    status: "scheduled",
    cancelledAt: null,
    enRouteAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    technicianId: "t1",
    ...over,
  };
}

function input(action: TechAction, over: Partial<Omit<ResolveInput, "row">> & { row?: Partial<TechAssignmentRow> } = {}): ResolveInput {
  const { row: r, ...rest } = over;
  return { action, row: row(r), requestStatus: "scheduled", activeVisitId: "v1", activeLeadId: "t1", native: true, ...rest };
}

describe("closeOutAllowedStatuses", () => {
  it("is derived from canTransition(s, completed)", () => {
    expect([...closeOutAllowedStatuses()].sort()).toEqual(["in_progress", "on_hold"]);
  });
});

describe("resolveTechAction", () => {
  it("refuses non-native jobs for every action", () => {
    for (const a of TECH_ACTIONS) {
      expect(resolveTechAction(input(a, { native: false }))).toEqual({ kind: "refuse", reason: "managed_externally" });
    }
  });

  it("refuses every action when the caller's own row is cancelled", () => {
    for (const a of TECH_ACTIONS) {
      expect(resolveTechAction(input(a, { row: { status: "cancelled" } }))).toEqual({ kind: "refuse", reason: "invalid_transition" });
    }
  });

  it("refuses every action when cancelledAt is set though status is not cancelled", () => {
    for (const a of TECH_ACTIONS) {
      expect(resolveTechAction(input(a, { row: { status: "en_route", cancelledAt: T } }))).toEqual({ kind: "refuse", reason: "invalid_transition" });
    }
  });

  it("lead en_route writes row + request, no time entry", () => {
    expect(resolveTechAction(input("en_route"))).toEqual({
      kind: "write", assignmentTo: "en_route", stamp: "enRouteAt", requestTo: "en_route", timeEntry: "none",
    });
  });

  it("time entry matrix", () => {
    const arrived = resolveTechAction(input("arrived", { row: { status: "en_route", enRouteAt: T }, requestStatus: "en_route" }));
    expect(arrived).toMatchObject({ kind: "write", stamp: "arrivedAt", requestTo: "arrived", timeEntry: "open" });
    const started = resolveTechAction(input("in_progress", { row: { status: "arrived", arrivedAt: T }, requestStatus: "arrived" }));
    expect(started).toMatchObject({ kind: "write", stamp: "startedAt", requestTo: "in_progress", timeEntry: "open" });
    const paused = resolveTechAction(input("pause", { row: { status: "in_progress", startedAt: T }, requestStatus: "in_progress" }));
    expect(paused).toEqual({ kind: "write", assignmentTo: "on_hold", stamp: null, requestTo: null, timeEntry: "close" });
    const done = resolveTechAction(input("completed", { row: { status: "in_progress", startedAt: T }, requestStatus: "in_progress", activeVisitId: "other" }));
    expect(done).toMatchObject({ kind: "write", stamp: "completedAt", timeEntry: "close" });
  });

  it("invalid transition pending -> arrived", () => {
    expect(resolveTechAction(input("arrived", { row: { status: "pending" } }))).toEqual({ kind: "refuse", reason: "invalid_transition" });
  });

  describe("close_out and hold", () => {
    it("helper hold and close_out -> not_lead", () => {
      expect(resolveTechAction(input("on_hold", { row: { isLead: false } }))).toEqual({ kind: "refuse", reason: "not_lead" });
      expect(resolveTechAction(input("close_out", { row: { isLead: false } }))).toEqual({ kind: "refuse", reason: "not_lead" });
    });
    it("lead of a later visit -> not_lead", () => {
      const r = { appointmentId: "v2", appointmentNumber: 2 };
      expect(resolveTechAction(input("on_hold", { row: r }))).toEqual({ kind: "refuse", reason: "not_lead" });
      expect(resolveTechAction(input("close_out", { row: r }))).toEqual({ kind: "refuse", reason: "not_lead" });
    });
    it("active lead hold -> hold, even when row is on_hold or completed", () => {
      for (const status of ["in_progress", "on_hold", "completed"] as const) {
        expect(resolveTechAction(input("on_hold", { row: { status, startedAt: T }, requestStatus: "in_progress" }))).toEqual({ kind: "hold" });
      }
    });
    it("hold with request pending -> invalid_transition", () => {
      expect(resolveTechAction(input("on_hold", { requestStatus: "pending" }))).toEqual({ kind: "refuse", reason: "invalid_transition" });
    });
    it("active lead close_out -> close_out regardless of row status", () => {
      for (const status of ["completed", "on_hold", "in_progress"] as const) {
        expect(resolveTechAction(input("close_out", { row: { status } }))).toEqual({ kind: "close_out" });
      }
    });
  });

  describe("completed", () => {
    it("requires startedAt on the row", () => {
      expect(resolveTechAction(input("completed", { row: { status: "in_progress" }, requestStatus: "in_progress" }))).toEqual({ kind: "refuse", reason: "not_started_row" });
    });
    it("active lead needs request in_progress/on_hold", () => {
      const r = { status: "in_progress" as const, startedAt: T };
      expect(resolveTechAction(input("completed", { row: r, requestStatus: "arrived" }))).toEqual({ kind: "refuse", reason: "request_not_started" });
      expect(resolveTechAction(input("completed", { row: r, requestStatus: "on_hold" }))).toMatchObject({ kind: "write", assignmentTo: "completed" });
    });
    it("helper completed -> requestTo null, ignoring request status", () => {
      const out = resolveTechAction(input("completed", { row: { isLead: false, status: "in_progress", startedAt: T }, requestStatus: "arrived" }));
      expect(out).toMatchObject({ kind: "write", requestTo: null });
    });
  });

  describe("noop and request_only", () => {
    it("lead in_progress row with stamp, request arrived -> request_only", () => {
      expect(resolveTechAction(input("in_progress", { row: { status: "in_progress", startedAt: T }, requestStatus: "arrived" }))).toEqual({ kind: "request_only", requestTo: "in_progress" });
    });
    it("row at target, request at target -> noop", () => {
      expect(resolveTechAction(input("in_progress", { row: { status: "in_progress", startedAt: T }, requestStatus: "in_progress" }))).toEqual({ kind: "noop" });
    });
    it("helper at target with request behind -> noop (no request_only)", () => {
      expect(resolveTechAction(input("in_progress", { row: { isLead: false, status: "in_progress", startedAt: T }, requestStatus: "arrived" }))).toEqual({ kind: "noop" });
    });
    it("request behind but transition illegal -> noop", () => {
      expect(resolveTechAction(input("arrived", { row: { status: "arrived", arrivedAt: T }, requestStatus: "pending" }))).toEqual({ kind: "noop" });
    });
    it("lead completed row with stamp, request in_progress -> noop, never request_only", () => {
      expect(resolveTechAction(input("completed", { row: { status: "completed", startedAt: T, completedAt: T }, requestStatus: "in_progress" }))).toEqual({ kind: "noop" });
    });
    it("active lead replaying completed after the request completed -> noop", () => {
      expect(resolveTechAction(input("completed", { row: { status: "completed", startedAt: T, completedAt: T }, requestStatus: "completed" }))).toEqual({ kind: "noop" });
    });
    it("request_only for arrived and en_route targets", () => {
      expect(resolveTechAction(input("arrived", { row: { status: "arrived", arrivedAt: T }, requestStatus: "en_route" }))).toEqual({ kind: "request_only", requestTo: "arrived" });
      expect(resolveTechAction(input("en_route", { row: { status: "en_route", enRouteAt: T }, requestStatus: "scheduled" }))).toEqual({ kind: "request_only", requestTo: "en_route" });
    });
    it("lead pause with row on_hold -> noop", () => {
      expect(resolveTechAction(input("pause", { row: { status: "on_hold", startedAt: T }, requestStatus: "on_hold" }))).toEqual({ kind: "noop" });
    });
    it("row in_progress with startedAt null (mirrored) -> write", () => {
      expect(resolveTechAction(input("in_progress", { row: { status: "in_progress" }, requestStatus: "in_progress" }))).toEqual({
        kind: "write", assignmentTo: "in_progress", stamp: "startedAt", requestTo: null, timeEntry: "open",
      });
    });
  });

  it("lead on a later visit writes with requestTo null", () => {
    const out = resolveTechAction(input("en_route", { row: { appointmentId: "v2", appointmentNumber: 2 } }));
    expect(out).toEqual({ kind: "write", assignmentTo: "en_route", stamp: "enRouteAt", requestTo: null, timeEntry: "none" });
  });

  it("helper en_route writes requestTo null", () => {
    expect(resolveTechAction(input("en_route", { row: { isLead: false } }))).toMatchObject({ kind: "write", requestTo: null });
  });

  it("requestTo null when the request transition is illegal", () => {
    const out = resolveTechAction(input("in_progress", { row: { status: "arrived", arrivedAt: T }, requestStatus: "completed" as RequestStatus }));
    expect(out).toMatchObject({ kind: "write", requestTo: null });
  });
});

describe("allowedActions", () => {
  const { action: _a, ...base } = input("en_route");
  void _a;

  it("helper gets no close_out / on_hold", () => {
    const list = allowedActions({ ...base, row: row({ isLead: false, status: "in_progress", startedAt: T }), requestStatus: "in_progress" });
    expect(list).not.toContain("close_out");
    expect(list).not.toContain("on_hold");
    expect(list).toContain("completed");
  });

  it("active lead with a completed row: close_out yes, completed no", () => {
    const list = allowedActions({ ...base, row: row({ status: "completed", startedAt: T, completedAt: T }), requestStatus: "in_progress" });
    expect(list).toContain("close_out");
    expect(list).not.toContain("completed");
  });

  it("active lead with an open en_route row gets close_out", () => {
    expect(allowedActions({ ...base, row: row({ status: "en_route", enRouteAt: T }), requestStatus: "en_route" })).toContain("close_out");
  });

  it("lead on a later visit keeps status buttons but not close_out/hold", () => {
    const list = allowedActions({ ...base, row: row({ appointmentId: "v2", appointmentNumber: 2 }) });
    expect(list).toContain("en_route");
    expect(list).not.toContain("close_out");
    expect(list).not.toContain("on_hold");
  });

  it("request_only keeps the button visible", () => {
    const list = allowedActions({ ...base, row: row({ status: "in_progress", startedAt: T }), requestStatus: "arrived" });
    expect(list).toContain("in_progress");
  });

  it("cancelled row allows nothing", () => {
    expect(allowedActions({ ...base, row: row({ status: "cancelled" }) })).toEqual([]);
  });
});
