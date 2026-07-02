import { describe, it, expect } from "vitest";
import {
  applyOptimisticReschedule,
  applyOptimisticUnschedule,
  currentScopeOf,
  UNASSIGNED_SCOPE,
} from "./calendar-optimistic";
import type { SchedulingCalendar, DashboardRequest } from "./types";

function job(overrides: Partial<DashboardRequest>): DashboardRequest {
  return {
    id: "job-1",
    referenceNumber: "REQ-1",
    customerName: "Jane",
    issueType: "no_cooling",
    urgency: "high",
    status: "scheduled",
    isAfterHours: false,
    assignedToName: null,
    arrivalWindowStart: null,
    arrivalWindowEnd: null,
    followUpDate: null,
    holdReason: null,
    autoAssigned: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

const TECH = "tech-a";

function board(partial: Partial<SchedulingCalendar>): SchedulingCalendar {
  return {
    days: ["2026-07-01"],
    lanes: [{ technicianId: TECH, technicianName: "Tech A", jobs: [] }],
    unassigned: [],
    unscheduled: [],
    availability: [],
    ...partial,
  };
}

describe("applyOptimisticReschedule", () => {
  it("moves a queued (unscheduled) job into a technician lane with the new Eastern window", () => {
    const queued = job({ id: "job-x", assignedToName: "Tech A" });
    const before = board({ unscheduled: [queued] });

    const after = applyOptimisticReschedule(before, {
      requestId: "job-x",
      scope: TECH,
      isoDay: "2026-07-01",
      window: "morning",
    });

    // Left the queue, landed in the tech lane.
    expect(after.unscheduled).toHaveLength(0);
    expect(after.lanes[0].jobs).toHaveLength(1);
    const moved = after.lanes[0].jobs[0];
    // Morning Eastern (EDT) = 12:00Z–16:00Z.
    expect(moved.arrivalWindowStart).toBe("2026-07-01T12:00:00.000Z");
    expect(moved.arrivalWindowEnd).toBe("2026-07-01T16:00:00.000Z");
  });

  it("does NOT mutate the input board (immutability)", () => {
    const queued = job({ id: "job-x" });
    const before = board({ unscheduled: [queued] });
    const snapshot = JSON.stringify(before);

    applyOptimisticReschedule(before, {
      requestId: "job-x",
      scope: TECH,
      isoDay: "2026-07-01",
      window: "afternoon",
    });

    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("moves a placed job between lanes and re-sorts the destination by window start", () => {
    const early = job({
      id: "early",
      arrivalWindowStart: "2026-07-01T12:00:00.000Z",
      arrivalWindowEnd: "2026-07-01T16:00:00.000Z",
    });
    const mover = job({
      id: "mover",
      arrivalWindowStart: "2026-07-01T23:00:00.000Z",
      arrivalWindowEnd: "2026-07-02T00:00:00.000Z",
    });
    const before = board({
      lanes: [{ technicianId: TECH, technicianName: "Tech A", jobs: [early, mover] }],
    });

    // Move "mover" to the unassigned pile, morning slot.
    const after = applyOptimisticReschedule(before, {
      requestId: "mover",
      scope: UNASSIGNED_SCOPE,
      isoDay: "2026-07-01",
      window: "morning",
    });

    expect(after.lanes[0].jobs.map((j) => j.id)).toEqual(["early"]);
    expect(after.unassigned.map((j) => j.id)).toEqual(["mover"]);
  });

  it("returns the SAME reference when the job id isn't on the board", () => {
    const before = board({});
    const after = applyOptimisticReschedule(before, {
      requestId: "ghost",
      scope: TECH,
      isoDay: "2026-07-01",
      window: "morning",
    });
    expect(after).toBe(before);
  });

  it("keeps an assigned job in its tech lane when rescheduled (server never reassigns)", () => {
    // Mirrors the week-view drop path: the destination scope is resolved from the
    // job's CURRENT lane (currentScopeOf), not the drop zone — so an assigned job
    // dragged to a new day/window stays with its technician rather than jumping to
    // the unassigned pile (which would diverge from the server until the refetch).
    const placed = job({
      id: "placed",
      assignedToName: "Tech A",
      arrivalWindowStart: "2026-07-01T16:00:00.000Z",
      arrivalWindowEnd: "2026-07-01T20:00:00.000Z",
    });
    const before = board({
      lanes: [{ technicianId: TECH, technicianName: "Tech A", jobs: [placed] }],
    });

    const scope = currentScopeOf(before, "placed");
    expect(scope).toBe(TECH);

    const after = applyOptimisticReschedule(before, {
      requestId: "placed",
      scope: scope!,
      isoDay: "2026-07-01",
      window: "morning",
    });

    expect(after.unassigned).toHaveLength(0);
    expect(after.lanes[0].jobs.map((j) => j.id)).toEqual(["placed"]);
    expect(after.lanes[0].jobs[0].arrivalWindowStart).toBe(
      "2026-07-01T12:00:00.000Z",
    );
  });
});

describe("currentScopeOf", () => {
  it("returns the technicianId for a job in a tech lane", () => {
    const placed = job({ id: "p" });
    const b = board({
      lanes: [{ technicianId: TECH, technicianName: "Tech A", jobs: [placed] }],
    });
    expect(currentScopeOf(b, "p")).toBe(TECH);
  });

  it("returns the unassigned scope for a placed-but-unassigned job", () => {
    const b = board({ unassigned: [job({ id: "u" })] });
    expect(currentScopeOf(b, "u")).toBe(UNASSIGNED_SCOPE);
  });

  it("returns the unassigned scope for a queued (unscheduled) job", () => {
    const b = board({ unscheduled: [job({ id: "q" })] });
    expect(currentScopeOf(b, "q")).toBe(UNASSIGNED_SCOPE);
  });

  it("returns null when the job isn't on the board", () => {
    expect(currentScopeOf(board({}), "ghost")).toBeNull();
  });
});

describe("applyOptimisticUnschedule", () => {
  it("moves a placed job out of its lane into the unscheduled queue and clears it", () => {
    const placed = job({
      id: "job-p",
      assignedToName: "Tech A",
      arrivalWindowStart: "2026-07-01T12:00:00.000Z",
      arrivalWindowEnd: "2026-07-01T16:00:00.000Z",
    });
    const before = board({
      lanes: [{ technicianId: TECH, technicianName: "Tech A", jobs: [placed] }],
    });

    const after = applyOptimisticUnschedule(before, "job-p");

    expect(after.lanes[0].jobs).toHaveLength(0);
    expect(after.unscheduled.map((j) => j.id)).toContain("job-p");
    const moved = after.unscheduled.find((j) => j.id === "job-p")!;
    expect(moved.arrivalWindowStart).toBeNull();
    expect(moved.arrivalWindowEnd).toBeNull();
    expect(moved.assignedToName).toBeNull();
  });

  it("returns the SAME reference when the job is not on the board", () => {
    const before = board({});
    expect(applyOptimisticUnschedule(before, "missing")).toBe(before);
  });
});
