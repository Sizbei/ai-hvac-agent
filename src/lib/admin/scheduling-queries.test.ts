import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mock state ─────────────────────────────────────────────
// Mirrors crm-queries.test.ts: a chainable thenable proxy stands in for the
// drizzle query builder, and per-call result queues feed each db.select/delete.
// We additionally capture the WHERE condition handed to each query so we can
// assert what was filtered (overlap bounds, tenant scope, exclude-self).
const {
  selectQueue,
  deleteQueue,
  updateQueue,
  whereCalls,
  insertMock,
  batchMock,
  chain,
} = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const deleteQueue: unknown[][] = [];
  const updateQueue: unknown[][] = [];
  const whereCalls: unknown[][] = [];
  const insertMock = vi.fn();
  const batchMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  const chain = (resolved: unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => resolve(resolved);
        }
        if (prop === "where") {
          return (...args: unknown[]) => {
            whereCalls.push(args);
            return p;
          };
        }
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };
  return {
    selectQueue,
    deleteQueue,
    updateQueue,
    whereCalls,
    insertMock,
    batchMock,
    chain,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    delete: () => chain(deleteQueue.shift() ?? []),
    update: () => chain(updateQueue.shift() ?? []),
    insert: () => ({
      values: (v: unknown) => {
        insertMock(v);
        return chain([]);
      },
    }),
    execute: (q: unknown) => ({ __lock: q }),
    batch: (...args: unknown[]) => batchMock(...args),
  },
}));

// isTerminal is the only request-status surface rescheduleRequest uses; mock it
// rather than pull the real enum (the schema mock omits requestStatusEnum).
vi.mock("./request-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./request-status")>()),
  isTerminal: (status: string) =>
    status === "completed" || status === "cancelled",
}));

// withTenant returns a tagged condition carrying the org id and the extra
// conditions, so tests can assert tenant scoping and inspect the filters.
vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_table: unknown, orgId: string, ...conditions: unknown[]) => ({
    __tenant: orgId,
    conditions,
  }),
}));

vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => ["eq", ...a],
  ne: (...a: unknown[]) => ["ne", ...a],
  and: (...a: unknown[]) => ["and", ...a],
  or: (...a: unknown[]) => ["or", ...a],
  asc: (c: unknown) => c,
  gt: (...a: unknown[]) => ["gt", ...a],
  lt: (...a: unknown[]) => ["lt", ...a],
  inArray: (...a: unknown[]) => ["inArray", ...a],
  isNull: (c: unknown) => ["isNull", c],
  isNotNull: (c: unknown) => ["isNotNull", c],
  sql: (_strings: TemplateStringsArray, ..._vals: unknown[]) => ["sql"],
}));

vi.mock("@/lib/db/schema", () => ({
  requestStatusEnum: {
    enumValues: ["pending", "scheduled", "assigned", "en_route", "arrived", "in_progress", "on_hold", "completed", "cancelled"],
  },
  holdReasonEnum: {
    enumValues: ["awaiting_parts", "awaiting_customer", "awaiting_access", "weather", "other"],
  },
  serviceRequests: {
    id: "sr.id",
    organizationId: "sr.org",
    assignedTo: "sr.assignedTo",
    status: "sr.status",
    referenceNumber: "sr.ref",
    scheduledDate: "sr.scheduled",
    arrivalWindowStart: "sr.aws",
    arrivalWindowEnd: "sr.awe",
    updatedAt: "sr.updated",
    createdAt: "sr.created",
    jobType: "sr.jobType",
    systemType: "sr.systemType",
    urgency: "sr.urgency",
    autoAssigned: "sr.autoAssigned",
    locationId: "sr.locationId",
    addressEncrypted: "sr.addressEnc",
    customerPhoneEncrypted: "sr.phoneEnc",
    customerEmailEncrypted: "sr.emailEnc",
  },
  organizationSettings: {
    organizationId: "os.org",
    autoDispatchEnabled: "os.autoDispatch",
    schedulingSource: "os.schedulingSource",
  },
  technicianAvailability: {
    id: "ta.id",
    organizationId: "ta.org",
    technicianId: "ta.tech",
    dayOfWeek: "ta.dow",
    startMinute: "ta.start",
    endMinute: "ta.end",
  },
  users: {
    id: "u.id",
    organizationId: "u.org",
    role: "u.role",
    isActive: "u.active",
    name: "u.name",
  },
  customerLocations: {
    id: "cl.id",
    organizationId: "cl.org",
    latitude: "cl.lat",
    longitude: "cl.lng",
  },
  dispatchDecisions: {
    id: "dd.id",
    organizationId: "dd.org",
    serviceRequestId: "dd.req",
    outcome: "dd.outcome",
    isShadow: "dd.isShadow",
    chosenTechnicianId: "dd.chosen",
    topScore: "dd.topScore",
    confidenceGap: "dd.gap",
    candidates: "dd.candidates",
  },
}));

// Scored-dispatch siblings: stub the signals loader (so it doesn't touch the db
// queue) and rankTechnicians (so the test controls the candidate order). The
// real placeAndAssignRequest still runs, driven by the db queue, so we observe
// WHICH tech the orchestrator tried first via the returned technicianId.
const { rankedState, loggerInfo } = vi.hoisted(() => ({
  rankedState: { order: [] as string[] },
  loggerInfo: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Spy on the KPI status-event writer so we can assert the first-response
// instrumentation fires (and with the right actor) without a real DB.
vi.mock("@/lib/admin/status-events", () => ({
  recordStatusEvent: vi.fn(),
}));
vi.mock("@/lib/ai/dispatch/signals", () => ({
  // Mirror the real loader's contract: a defaulted entry for every requested
  // tech (the real one never returns a missing tech).
  loadDispatchSignals: vi.fn(async (_org: string, ids: readonly string[]) =>
    new Map(
      ids.map((id) => [
        id,
        { skillJobsCompleted: 0, skillJobsCompletedRecent: 0, avgRating: null, sameDayJobCount: 0, bookedMinutes: 0, dayMinutes: 720, thisJobEstimate: 0 },
      ]),
    ),
  ),
}));
vi.mock("@/lib/ai/dispatch/score", async (importOriginal) => ({
  // Keep the real classifyDispatch (the confidence gate) so tests exercise the
  // actual commit/queue decision; only stub the ranker.
  ...(await importOriginal<typeof import("@/lib/ai/dispatch/score")>()),
  // Descending scores (0.1 apart) so the top tech clears MIN_CONFIDENCE_GAP and
  // classifyDispatch commits to the ranked-first tech rather than queuing a tie.
  rankTechnicians: () =>
    rankedState.order.map((technicianId, i) => ({
      technicianId,
      score: 1 - i * 0.1,
      reasons: [],
      skillMatched: true,
    })),
}));

// Shift reads are their own module: default to "nobody is off"; a test sets
// blocks to exercise the time-off paths.
const { timeOffMock, capacityBlocksMock } = vi.hoisted(() => ({
  timeOffMock: vi.fn(),
  capacityBlocksMock: vi.fn(),
}));
vi.mock("./shift-queries", () => ({
  technicianTimeOffOverlapping: timeOffMock,
  listCapacityBlocks: capacityBlocksMock,
}));

// Markers for the visit-#1 guards so tests can find them in the guarded WHERE.
vi.mock("./visit-one-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./visit-one-guard")>()),
  visitOneGuardSql: () => "VISIT_ONE_GUARD",
  visitOneStartedGuardSql: () => "VISIT_ONE_STARTED_GUARD",
}));
vi.mock("./visit-move-sql", () => ({
  reviveLeadSql: () => "REVIVE_LEAD",
  requestXminGateSql: () => "XMIN_GATE",
  leadDoneSql: () => "LEAD_DONE",
  startedOnVisitOneSql: () => "STARTED_ON_V1",
  versionGateSql: () => "VERSION_GATE",
  noWorkLoggedSql: () => "NO_WORK_LOGGED",
  fieldpulseFreeSql: () => "FIELDPULSE_FREE",
}));

import {
  unscheduleRequest,
  getTechnicianAvailability,
  setTechnicianAvailability,
  InvalidAvailabilitySlotError,
  checkScheduleConflict,
  getScheduledJobsForRange,
  listUnscheduledRequests,
  rescheduleRequest,
  placeAndAssignRequest,
  autoAssignBookedRequest,
  suggestTechnicians,
} from "./scheduling-queries";
import { SHOW_ALL, VISIBLE_ONLY } from "./visibility";
import { recordStatusEvent } from "@/lib/admin/status-events";
import { loadDispatchSignals } from "@/lib/ai/dispatch/signals";

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000002";
const TECH = "00000000-0000-0000-0000-0000000000a1";
const REQ = "00000000-0000-0000-0000-0000000000b1";

function tenantOrgOf(callIndex: number): string {
  const arg = whereCalls[callIndex]?.[0] as { __tenant?: string } | undefined;
  return arg?.__tenant ?? "";
}

beforeEach(() => {
  selectQueue.length = 0;
  deleteQueue.length = 0;
  updateQueue.length = 0;
  whereCalls.length = 0;
  insertMock.mockClear();
  batchMock.mockClear();
  // Pass-through: each statement resolves to its own queued rows, like db.batch.
  batchMock.mockImplementation(async (qs: unknown) =>
    Promise.all((qs as unknown[]).map((q) => Promise.resolve(q))),
  );
  loggerInfo.mockClear();
  vi.mocked(recordStatusEvent).mockClear();
  timeOffMock.mockReset();
  timeOffMock.mockResolvedValue([]);
  capacityBlocksMock.mockReset();
  capacityBlocksMock.mockResolvedValue([]);
});

function timeOffShift(technicianId: string, startsAt: string, endsAt: string) {
  return {
    id: "shift-1",
    technicianId,
    kind: "time_off" as const,
    title: null,
    startsAt,
    endsAt,
    removesCapacity: true,
  };
}

describe("getTechnicianAvailability", () => {
  it("maps rows and scopes to the org", async () => {
    selectQueue.push([
      {
        id: "av1",
        technicianId: TECH,
        dayOfWeek: 1,
        startMinute: 480,
        endMinute: 1020,
      },
    ]);
    const result = await getTechnicianAvailability(ORG);
    expect(result).toEqual([
      { id: "av1", technicianId: TECH, dayOfWeek: 1, startMinute: 480, endMinute: 1020 },
    ]);
    expect(tenantOrgOf(0)).toBe(ORG);
  });

  it("adds a technician filter when technicianId is given", async () => {
    selectQueue.push([]);
    await getTechnicianAvailability(ORG, TECH);
    const tenantArg = whereCalls[0][0] as { conditions: unknown[] };
    // One extra condition: the technician eq filter.
    expect(tenantArg.conditions).toHaveLength(1);
    expect(tenantArg.conditions[0]).toEqual(["eq", "ta.tech", TECH]);
  });
});

describe("setTechnicianAvailability", () => {
  it("clears with a lone delete (no batch) when slots is empty", async () => {
    deleteQueue.push([]);
    await setTechnicianAvailability(ORG, TECH, []);
    expect(batchMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    // The delete is org+tech scoped.
    expect(tenantOrgOf(0)).toBe(ORG);
    const tenantArg = whereCalls[0][0] as { conditions: unknown[] };
    expect(tenantArg.conditions[0]).toEqual(["eq", "ta.tech", TECH]);
  });

  it("replaces in one batch: delete + insert", async () => {
    deleteQueue.push([]);
    await setTechnicianAvailability(ORG, TECH, [
      { dayOfWeek: 1, startMinute: 480, endMinute: 720 },
      { dayOfWeek: 1, startMinute: 780, endMinute: 1020 },
    ]);
    expect(batchMock).toHaveBeenCalledTimes(1);
    const statements = batchMock.mock.calls[0][0] as unknown[];
    expect(statements).toHaveLength(2); // delete + insert
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a back-to-back split shift (8–12 then 12–17)", async () => {
    deleteQueue.push([]);
    await expect(
      setTechnicianAvailability(ORG, TECH, [
        { dayOfWeek: 1, startMinute: 480, endMinute: 720 },
        { dayOfWeek: 1, startMinute: 720, endMinute: 1020 },
      ]),
    ).resolves.toBeUndefined();
    expect(batchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an end-of-day slot ending exactly at 1440", async () => {
    deleteQueue.push([]);
    await expect(
      setTechnicianAvailability(ORG, TECH, [
        { dayOfWeek: 6, startMinute: 0, endMinute: 1440 },
      ]),
    ).resolves.toBeUndefined();
    expect(batchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["dayOfWeek below 0", { dayOfWeek: -1, startMinute: 480, endMinute: 720 }],
    ["dayOfWeek above 6", { dayOfWeek: 7, startMinute: 480, endMinute: 720 }],
    ["non-integer dayOfWeek", { dayOfWeek: 1.5, startMinute: 480, endMinute: 720 }],
    ["negative startMinute", { dayOfWeek: 1, startMinute: -1, endMinute: 720 }],
    ["start == end", { dayOfWeek: 1, startMinute: 600, endMinute: 600 }],
    ["start > end", { dayOfWeek: 1, startMinute: 720, endMinute: 480 }],
    ["endMinute above 1440", { dayOfWeek: 1, startMinute: 1200, endMinute: 1441 }],
    ["non-integer startMinute", { dayOfWeek: 1, startMinute: 1.5, endMinute: 720 }],
  ])("rejects an out-of-range slot (%s) without touching the DB", async (_label, slot) => {
    await expect(
      setTechnicianAvailability(ORG, TECH, [slot]),
    ).rejects.toBeInstanceOf(InvalidAvailabilitySlotError);
    // Validation runs BEFORE any write — nothing is deleted or inserted.
    expect(batchMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("rejects the whole set when ANY slot is invalid (no partial write)", async () => {
    await expect(
      setTechnicianAvailability(ORG, TECH, [
        { dayOfWeek: 1, startMinute: 480, endMinute: 720 }, // valid
        { dayOfWeek: 1, startMinute: 720, endMinute: 480 }, // invalid
      ]),
    ).rejects.toBeInstanceOf(InvalidAvailabilitySlotError);
    expect(batchMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("checkScheduleConflict", () => {
  const START = "2026-06-10T12:00:00.000Z";
  const END = "2026-06-10T16:00:00.000Z";

  it("returns overlapping jobs (conflict) for the tech", async () => {
    selectQueue.push([
      {
        id: "j1",
        referenceNumber: "REF-1",
        status: "assigned",
        assignedTo: TECH,
        arrivalWindowStart: new Date("2026-06-10T13:00:00.000Z"),
        arrivalWindowEnd: new Date("2026-06-10T17:00:00.000Z"),
      },
    ]);
    const result = await checkScheduleConflict(ORG, TECH, START, END);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("j1");
    expect(result[0].arrivalWindowStart).toBe("2026-06-10T13:00:00.000Z");
  });

  it("appends the tech's overlapping time off as a 'Time off' clash", async () => {
    selectQueue.push([]); // no overlapping job
    timeOffMock.mockResolvedValue([
      timeOffShift(TECH, "2026-06-10T13:00:00.000Z", "2026-06-10T22:00:00.000Z"),
    ]);
    const result = await checkScheduleConflict(ORG, TECH, START, END);
    expect(result).toHaveLength(1);
    expect(result[0].referenceNumber).toBe("Time off");
    expect(timeOffMock).toHaveBeenCalledWith(ORG, TECH, new Date(START), new Date(END));
  });

  it("returns no conflict (empty) when the DB matches nothing", async () => {
    selectQueue.push([]); // no overlapping row
    const result = await checkScheduleConflict(ORG, TECH, START, END);
    expect(result).toEqual([]);
  });

  it("filters on the tech, active statuses, and half-open overlap bounds", async () => {
    selectQueue.push([]);
    await checkScheduleConflict(ORG, TECH, START, END);
    const conds = (whereCalls[0][0] as { conditions: unknown[] }).conditions;
    // assignedTo == tech
    expect(conds).toContainEqual(["eq", "sr.assignedTo", TECH]);
    // existing.start < proposed.end
    expect(conds).toContainEqual(["lt", "sr.aws", new Date(END)]);
    // existing.end > proposed.start — STRICT, so a back-to-back booking whose
    // window ends exactly at `start` is NOT a conflict (half-open intervals).
    expect(conds).toContainEqual(["gt", "sr.awe", new Date(START)]);
    // Guard against the off-by-one regression: the end bound must not be gte.
    expect(conds.some((c) => Array.isArray(c) && c[0] === "gte")).toBe(false);
    // active booking statuses are checked via inArray on status
    const statusCond = conds.find(
      (c) => Array.isArray(c) && c[0] === "inArray" && c[1] === "sr.status",
    ) as unknown[];
    expect(statusCond[2]).toContain("in_progress");
    expect(statusCond[2]).not.toContain("completed");
  });

  it("excludes the given request (reschedule self) via ne", async () => {
    selectQueue.push([]);
    await checkScheduleConflict(ORG, TECH, START, END, REQ);
    const conds = (whereCalls[0][0] as { conditions: unknown[] }).conditions;
    expect(conds).toContainEqual(["ne", "sr.id", REQ]);
  });

  it("does not add the ne filter when no exclude id is given", async () => {
    selectQueue.push([]);
    await checkScheduleConflict(ORG, TECH, START, END);
    const conds = (whereCalls[0][0] as { conditions: unknown[] }).conditions;
    expect(conds.some((c) => Array.isArray(c) && c[0] === "ne")).toBe(false);
  });

  it("is tenant-scoped: the org passed flows to withTenant", async () => {
    selectQueue.push([]);
    await checkScheduleConflict(OTHER_ORG, TECH, START, END);
    expect(tenantOrgOf(0)).toBe(OTHER_ORG);
    expect(tenantOrgOf(0)).not.toBe(ORG);
  });
});

describe("getScheduledJobsForRange", () => {
  it("uses a strict (gt) end bound — half-open range, no gte off-by-one", async () => {
    selectQueue.push([]);
    await getScheduledJobsForRange(
      ORG,
      "2026-06-10T00:00:00.000Z",
      "2026-06-11T00:00:00.000Z",
    );
    const conds = (whereCalls[0][0] as { conditions: unknown[] }).conditions;
    expect(
      conds.some((c) => Array.isArray(c) && c[0] === "gt" && c[1] === "sr.awe"),
    ).toBe(true);
    expect(conds.some((c) => Array.isArray(c) && c[0] === "gte")).toBe(false);
  });

  it("maps rows and scopes to the org", async () => {
    selectQueue.push([
      {
        id: "j2",
        referenceNumber: "REF-2",
        status: "scheduled",
        assignedTo: null,
        arrivalWindowStart: new Date("2026-06-10T08:00:00.000Z"),
        arrivalWindowEnd: new Date("2026-06-10T12:00:00.000Z"),
      },
    ]);
    const result = await getScheduledJobsForRange(
      ORG,
      "2026-06-10T00:00:00.000Z",
      "2026-06-11T00:00:00.000Z",
    );
    expect(result).toHaveLength(1);
    expect(result[0].assignedTo).toBeNull();
    expect(tenantOrgOf(0)).toBe(ORG);
  });
});

describe("listUnscheduledRequests", () => {
  it("scopes to unscheduled statuses and surfaces a null window as null", async () => {
    selectQueue.push([
      {
        id: "u1",
        referenceNumber: "REF-3",
        status: "pending",
        assignedTo: null,
        arrivalWindowStart: null,
        arrivalWindowEnd: null,
      },
    ]);
    const result = await listUnscheduledRequests(ORG, VISIBLE_ONLY);
    expect(result).toEqual([
      {
        id: "u1",
        referenceNumber: "REF-3",
        status: "pending",
        assignedTo: null,
        arrivalWindowStart: null,
        arrivalWindowEnd: null,
      },
    ]);
    const conds = (whereCalls[0][0] as { conditions: unknown[] }).conditions;
    const statusCond = conds.find(
      (c) => Array.isArray(c) && c[0] === "inArray" && c[1] === "sr.status",
    ) as unknown[];
    // assigned/in_progress jobs with a null window are now surfaced too.
    expect(statusCond[2]).toEqual(["pending", "scheduled", "assigned", "en_route", "arrived", "in_progress"]);
    // "Unscheduled" = unassigned OR no window — an OR over the two null checks.
    expect(conds.some((c) => Array.isArray(c) && c[0] === "or")).toBe(true);
  });

  it("is tenant-isolated", async () => {
    selectQueue.push([]);
    await listUnscheduledRequests(OTHER_ORG, VISIBLE_ONLY);
    expect(tenantOrgOf(0)).toBe(OTHER_ORG);
  });
});

describe("rescheduleRequest", () => {
  // Morning Eastern on a summer day → 12:00Z–16:00Z (EDT, UTC-4).
  const WINDOW = {
    start: new Date("2026-07-01T12:00:00.000Z"),
    end: new Date("2026-07-01T16:00:00.000Z"),
  };

  it("returns request_not_found when the request isn't in the org", async () => {
    selectQueue.push([]); // status lookup misses
    const result = await rescheduleRequest(ORG, REQ, WINDOW);
    expect(result).toEqual({ ok: false, reason: "request_not_found" });
    // Tenant-scoped read, and no UPDATE attempted.
    expect(tenantOrgOf(0)).toBe(ORG);
    expect(updateQueue.length).toBe(0);
  });

  it("rejects a terminal request without writing", async () => {
    selectQueue.push([{ status: "completed", assignedTo: null }]);
    const result = await rescheduleRequest(ORG, REQ, WINDOW);
    expect(result).toEqual({
      ok: false,
      reason: "request_terminal",
      currentStatus: "completed",
    });
  });

  it("writes the new window (guarded on current status) and reports no conflict when unassigned", async () => {
    selectQueue.push([{ status: "scheduled", assignedTo: null }]);
    updateQueue.push([
      {
        status: "scheduled",
        assignedTo: null,
        scheduledDate: WINDOW.start,
        arrivalWindowStart: WINDOW.start,
        arrivalWindowEnd: WINDOW.end,
      },
    ]);

    const result = await rescheduleRequest(ORG, REQ, WINDOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheduledDate).toBe(WINDOW.start.toISOString());
    expect(result.arrivalWindowStart).toBe(WINDOW.start.toISOString());
    expect(result.arrivalWindowEnd).toBe(WINDOW.end.toISOString());
    expect(result.conflicts).toEqual([]); // unassigned → no conflict check
    // The UPDATE is tenant-scoped and guarded on the status we just read.
    const updateWhere = whereCalls[1][0] as { __tenant: string; conditions: unknown[] };
    expect(updateWhere.__tenant).toBe(ORG);
    const andCond = updateWhere.conditions[0] as unknown[];
    expect(andCond).toContainEqual(["eq", "sr.status", "scheduled"]);
  });

  it("surfaces SOFT conflicts for an assigned job (same-tech overlap)", async () => {
    selectQueue.push([{ status: "assigned", assignedTo: TECH }]);
    updateQueue.push([
      {
        status: "assigned",
        assignedTo: TECH,
        scheduledDate: WINDOW.start,
        arrivalWindowStart: WINDOW.start,
        arrivalWindowEnd: WINDOW.end,
      },
    ]);
    // The conflict check (checkScheduleConflict) is the 3rd db call → a select.
    selectQueue.push([
      {
        id: "other-job",
        referenceNumber: "REQ-999",
        status: "assigned",
        assignedTo: TECH,
        arrivalWindowStart: WINDOW.start,
        arrivalWindowEnd: WINDOW.end,
      },
    ]);

    const result = await rescheduleRequest(ORG, REQ, WINDOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].id).toBe("other-job");
    // The conflict check excludes THIS request (ne self) so it isn't self-flagged.
    const conflictWhere = whereCalls[2][0] as { conditions: unknown[] };
    expect(conflictWhere.conditions).toContainEqual(["ne", "sr.id", REQ]);
  });

  it("reports request_not_found when the status-guarded UPDATE matches zero rows", async () => {
    // Read sees a live status, but a concurrent write moved it before our UPDATE.
    selectQueue.push([{ status: "scheduled", assignedTo: null }]);
    updateQueue.push([]); // guarded update matched nothing
    const result = await rescheduleRequest(ORG, REQ, WINDOW);
    expect(result).toEqual({ ok: false, reason: "request_not_found" });
  });

  it("is tenant-isolated", async () => {
    selectQueue.push([]);
    await rescheduleRequest(OTHER_ORG, REQ, WINDOW);
    expect(tenantOrgOf(0)).toBe(OTHER_ORG);
  });
});

describe("placeAndAssignRequest (S4 hard enforcement)", () => {
  // 2026-07-01 is a WEDNESDAY (business weekday 3). Morning Eastern (EDT, UTC-4)
  // is 12:00Z–16:00Z = wall-clock minutes [480, 720). A Wed slot 8am–12pm
  // (480→720) exactly covers it; a slot ending at 11am (660) leaves it uncovered.
  const ISO_DAY = "2026-07-01";
  const WINDOW = {
    start: new Date("2026-07-01T12:00:00.000Z"),
    end: new Date("2026-07-01T16:00:00.000Z"),
  };
  const WED = 3;
  const coversMorning = [
    { id: "av", technicianId: TECH, dayOfWeek: WED, startMinute: 480, endMinute: 720 },
  ];
  const noMorning = [
    { id: "av", technicianId: TECH, dayOfWeek: WED, startMinute: 480, endMinute: 660 },
  ];

  function updatedRow(assignedTo: string | null) {
    return {
      status: "scheduled",
      assignedTo,
      scheduledDate: WINDOW.start,
      arrivalWindowStart: WINDOW.start,
      arrivalWindowEnd: WINDOW.end,
    };
  }

  it("commits a pure reschedule (no tech change) within availability with no conflict", async () => {
    selectQueue.push([{ status: "scheduled", assignedTo: TECH }]); // 0: read
    selectQueue.push([]); // 1: conflict check → none
    selectQueue.push(coversMorning); // 2: availability → covers morning
    updateQueue.push([updatedRow(TECH)]); // 3: guarded UPDATE

    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignedTo).toBe(TECH);
    expect(result.overriddenConflicts).toBeNull();
    // No assignedTo in the UPDATE set (pure reschedule) — only the window moved.
  });

  it("BLOCKS (reason:conflict) on an overlapping job and does not write", async () => {
    selectQueue.push([{ status: "assigned", assignedTo: TECH }]); // 0: read
    selectQueue.push([
      {
        id: "other",
        referenceNumber: "REF-2",
        status: "assigned",
        assignedTo: TECH,
        arrivalWindowStart: WINDOW.start,
        arrivalWindowEnd: WINDOW.end,
      },
    ]); // 1: conflict check → overlap
    selectQueue.push(coversMorning); // 2: availability (still read)

    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("conflict");
    if (result.reason !== "conflict") return;
    expect(result.detail.conflicts).toHaveLength(1);
    expect(result.detail.conflicts[0].id).toBe("other");
    expect(result.detail.outsideAvailability).toBe(false);
    // The block is BEFORE the write: only the read + conflict + availability
    // selects ran (3), no UPDATE where-clause was recorded.
    expect(whereCalls).toHaveLength(3);
  });

  it("time off BLOCKS even with override:true, before any write", async () => {
    selectQueue.push([{ status: "assigned", assignedTo: TECH }]); // 0: read
    timeOffMock.mockResolvedValue([
      timeOffShift(TECH, "2026-07-01T13:00:00.000Z", "2026-07-01T22:00:00.000Z"),
    ]);
    updateQueue.push([updatedRow(TECH)]); // would succeed if reached

    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
      override: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "conflict") return;
    expect(result.detail.outsideAvailability).toBe(false);
    expect(result.detail.conflicts.map((c) => c.referenceNumber)).toEqual(["Time off"]);
    // Only the request read ran; the UPDATE was never issued.
    expect(whereCalls).toHaveLength(1);
    expect(updateQueue).toHaveLength(1);
  });

  it("a 0-row UPDATE caused by time off reports conflict, not request_not_found", async () => {
    selectQueue.push([{ status: "assigned", assignedTo: TECH }]); // 0: read
    // Pre-write check passes; a shift lands before the UPDATE (guard → 0 rows).
    timeOffMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        timeOffShift(TECH, "2026-07-01T13:00:00.000Z", "2026-07-01T22:00:00.000Z"),
      ]);
    updateQueue.push([]); // guarded UPDATE matched nothing

    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
      override: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("conflict");
  });

  it("BLOCKS on an out-of-hours window (availability boundary) without writing", async () => {
    selectQueue.push([{ status: "assigned", assignedTo: TECH }]); // 0: read
    selectQueue.push([]); // 1: no overlap
    selectQueue.push(noMorning); // 2: availability ends 11am → morning uncovered

    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "conflict") return;
    expect(result.detail.outsideAvailability).toBe(true);
    expect(result.detail.conflicts).toHaveLength(0);
  });

  it("commits with override:true despite a conflict and reports the overridden clash", async () => {
    selectQueue.push([{ status: "assigned", assignedTo: TECH }]); // 0: read
    // override skips the pre-write gate → next select is the UPDATE's, then the
    // post-write recompute (conflict + availability) for the audit detail.
    updateQueue.push([updatedRow(TECH)]); // 1: guarded UPDATE
    selectQueue.push([
      {
        id: "other",
        referenceNumber: "REF-9",
        status: "assigned",
        assignedTo: TECH,
        arrivalWindowStart: WINDOW.start,
        arrivalWindowEnd: WINDOW.end,
      },
    ]); // 2: post-write conflict recompute
    selectQueue.push(coversMorning); // 3: post-write availability

    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
      override: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overriddenConflicts).not.toBeNull();
    expect(result.overriddenConflicts?.conflicts).toHaveLength(1);
  });

  it("drag-to-assign: rejects when the target tech isn't an active technician", async () => {
    selectQueue.push([{ status: "pending", assignedTo: null }]); // 0: read
    selectQueue.push([]); // 1: tech verification → not found

    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
      technicianId: TECH,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("technician_not_found");
    // No conflict check, no write — bailed at tech verification.
    expect(updateQueue.length).toBe(0);
  });

  it("drag-to-assign: verifies tech, checks conflict, and writes assignedTo", async () => {
    selectQueue.push([{ status: "pending", assignedTo: null }]); // 0: read
    selectQueue.push([{ id: TECH }]); // 1: tech verification → active tech
    selectQueue.push([]); // 2: conflict check → none
    selectQueue.push(coversMorning); // 3: availability → covers
    updateQueue.push([updatedRow(TECH)]); // 4: guarded UPDATE

    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
      technicianId: TECH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignedTo).toBe(TECH);
    // The tech-verification read is org-scoped and filters role+active.
    const techWhere = whereCalls[1][0] as { __tenant: string; conditions: unknown[] };
    expect(techWhere.__tenant).toBe(ORG);
  });

  it("records an assigned/human event on a drag reassignment (first-response KPI)", async () => {
    selectQueue.push([{ status: "pending", assignedTo: null }]); // 0: read
    selectQueue.push([{ id: TECH }]); // 1: tech verification → active
    selectQueue.push([]); // 2: conflict → none
    selectQueue.push(coversMorning); // 3: availability → covers
    updateQueue.push([updatedRow(TECH)]); // 4: guarded UPDATE

    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
      technicianId: TECH,
    });
    expect(result.ok).toBe(true);
    // A dispatcher drag is a human first response.
    expect(recordStatusEvent).toHaveBeenCalledWith(
      expect.objectContaining({ toStatus: "assigned", actorType: "human" }),
    );
  });

  it("records a SYSTEM assigned event when the caller marks it auto-dispatch", async () => {
    selectQueue.push([{ status: "pending", assignedTo: null }]); // 0: read
    selectQueue.push([{ id: TECH }]); // 1: tech verification → active
    selectQueue.push([]); // 2: conflict → none
    selectQueue.push(coversMorning); // 3: availability → covers
    updateQueue.push([updatedRow(TECH)]); // 4: guarded UPDATE

    await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
      technicianId: TECH,
      assignmentActor: "system",
    });
    expect(recordStatusEvent).toHaveBeenCalledWith(
      expect.objectContaining({ toStatus: "assigned", actorType: "system" }),
    );
  });

  it("records NO event when RE-assigning an already-assigned job (not a first response)", async () => {
    const OTHER_TECH = "00000000-0000-0000-0000-0000000000a2";
    selectQueue.push([{ status: "assigned", assignedTo: TECH }]); // 0: read (already on TECH)
    selectQueue.push([{ id: OTHER_TECH }]); // 1: tech verification → active
    selectQueue.push([]); // 2: conflict → none
    selectQueue.push(coversMorning); // 3: availability → covers
    updateQueue.push([updatedRow(OTHER_TECH)]); // 4: guarded UPDATE

    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
      technicianId: OTHER_TECH,
    });
    expect(result.ok).toBe(true);
    // A second-tech reassignment is a second response — no assigned event.
    expect(recordStatusEvent).not.toHaveBeenCalled();
  });

  it("records NO event on a pure reschedule (no tech change)", async () => {
    selectQueue.push([{ status: "scheduled", assignedTo: TECH }]); // 0: read (already on TECH)
    selectQueue.push([]); // 1: conflict → none
    selectQueue.push(coversMorning); // 2: availability → covers
    updateQueue.push([updatedRow(TECH)]); // 3: guarded UPDATE

    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
    });
    expect(result.ok).toBe(true);
    // A reschedule keeps the assignee — it is not a first response.
    expect(recordStatusEvent).not.toHaveBeenCalled();
  });

  it("rejects a terminal request without writing", async () => {
    selectQueue.push([{ status: "completed", assignedTo: TECH }]);
    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
    });
    expect(result).toMatchObject({ ok: false, reason: "request_terminal" });
    expect(updateQueue.length).toBe(0);
  });

  it("returns request_not_found when the request isn't in the org", async () => {
    selectQueue.push([]); // status read misses
    const result = await placeAndAssignRequest(OTHER_ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
    });
    expect(result).toMatchObject({ ok: false, reason: "request_not_found" });
    expect(tenantOrgOf(0)).toBe(OTHER_ORG);
  });

  it("skips the conflict gate for an unassigned reschedule (no target tech)", async () => {
    selectQueue.push([{ status: "scheduled", assignedTo: null }]); // 0: read
    updateQueue.push([updatedRow(null)]); // 1: UPDATE (no gate selects between)

    const result = await placeAndAssignRequest(ORG, REQ, WINDOW, {
      isoDay: ISO_DAY,
      window: "morning",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignedTo).toBeNull();
    expect(result.overriddenConflicts).toBeNull();
  });
});

describe("autoAssignBookedRequest (scored vs first-fit)", () => {
  // 2026-07-01 is a Wednesday; morning Eastern covers 12:00Z–16:00Z (see above).
  const ISO_DAY = "2026-07-01";
  const HELD = {
    start: new Date("2026-07-01T12:00:00.000Z"),
    end: new Date("2026-07-01T16:00:00.000Z"),
    isoDay: ISO_DAY,
    window: "morning" as const,
  };
  const T1 = "00000000-0000-0000-0000-0000000000c1";
  const T2 = "00000000-0000-0000-0000-0000000000c2";
  const coversMorning = [
    { id: "av", technicianId: T1, dayOfWeek: 3, startMinute: 480, endMinute: 720 },
  ];
  function updatedRow(assignedTo: string) {
    return {
      status: "scheduled",
      assignedTo,
      scheduledDate: HELD.start,
      arrivalWindowStart: HELD.start,
      arrivalWindowEnd: HELD.end,
    };
  }
  // Feed the db queue for ONE successful placeAndAssignRequest of `tech`
  // (freshly-booked request → assignedTo null → reassigning path), plus the
  // trailing markAutoAssigned update.
  function queueSuccessfulPlacement(tech: string): void {
    selectQueue.push([{ status: "pending", assignedTo: null }]); // read existing
    selectQueue.push([{ id: tech }]); // tech verification → active
    selectQueue.push([]); // conflict check → none
    selectQueue.push(coversMorning); // availability → covers
    updateQueue.push([updatedRow(tech)]); // guarded UPDATE
    updateQueue.push([]); // markAutoAssigned UPDATE
  }

  // The fixed lead-in autoAssignBookedRequest runs after the active-tech list and
  // before ranking/placement: a best-effort duration estimate (run concurrently
  // with the tech list), ONE merged org-settings read (schedulingSource +
  // autoDispatchEnabled), and (scored mode only) the booking-quality gate. Each
  // needs its own no-op row so it doesn't consume the placement queue. Caller
  // pushes the active-tech list first; ensureEstimatedDuration's read is next
  // (it fires inside the same Promise.all as the tech list).
  function queueAutoAssignLeadIn(enabled: boolean): void {
    selectQueue.push([]); // ensureEstimatedDuration → no existing row → no update
    selectQueue.push([{ source: "native", autoDispatchEnabled: enabled }]); // merged settings read
    if (enabled) selectQueue.push([]); // assessBookingQualityForRequest → clean
  }

  const CLASSIFIED = {
    jobType: "no_cool",
    systemType: "central_ac",
    urgency: "standard",
  };

  it("disabled (default): tries technicians in DB order (first-fit, unchanged)", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]); // active techs (DB order)
    queueAutoAssignLeadIn(false); // duration/external/flag (scored gate skipped)
    // Disabled → the shadow branch still reads the classification; an unclassified
    // job records nothing, then first-fit places DB-order T1 (unchanged).
    selectQueue.push([{ jobType: null, systemType: null, urgency: "standard" }]);
    queueSuccessfulPlacement(T1); // first DB-order tech wins

    const result = await autoAssignBookedRequest(ORG, REQ, HELD);
    expect(result).toEqual({ assigned: true, technicianId: T1 });
    // First-fit has no score → nothing logged as a scored decision.
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it("a technician with time off over the held slot is not a first-fit candidate", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]); // active techs (DB order)
    capacityBlocksMock.mockResolvedValue([
      {
        id: "shift-1",
        referenceNumber: "Time off",
        status: "assigned",
        assignedTo: T1,
        arrivalWindowStart: HELD.start.toISOString(),
        arrivalWindowEnd: HELD.end.toISOString(),
      },
    ]);
    queueAutoAssignLeadIn(false);
    selectQueue.push([{ jobType: null, systemType: null, urgency: "standard" }]);
    queueSuccessfulPlacement(T2); // T1 is skipped, so T2 is the first try

    const result = await autoAssignBookedRequest(ORG, REQ, HELD);
    expect(result).toEqual({ assigned: true, technicianId: T2 });
    expect(capacityBlocksMock).toHaveBeenCalledWith(
      ORG,
      HELD.start.toISOString(),
      HELD.end.toISOString(),
    );
  });

  it("enabled: tries technicians in ranked order (best first)", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]); // active techs (DB order)
    queueAutoAssignLeadIn(true); // duration/external/flag/quality-gate
    selectQueue.push([CLASSIFIED]); // rankedTechnicianOrder → classification (reused by the confidence gate)
    rankedState.order = [T2, T1]; // ranker prefers T2 (clear score gap → committed)
    queueSuccessfulPlacement(T2); // ranked-first tech wins

    const result = await autoAssignBookedRequest(ORG, REQ, HELD);
    expect(result).toEqual({ assigned: true, technicianId: T2 });
    // The scored decision is logged so an operator can audit "why this tech?".
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ serviceRequestId: REQ, technicianId: T2 }),
      "Auto-dispatch: scored assignment",
    );
  });

  it("enabled with no skill-matched tech → {assigned:false} (gate did its job)", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]); // active techs
    queueAutoAssignLeadIn(true);
    selectQueue.push([CLASSIFIED]); // rankedTechnicianOrder → classification (reused by the gate)
    rankedState.order = []; // classified, but ranker drops everyone (nobody qualified)

    const result = await autoAssignBookedRequest(ORG, REQ, HELD);
    expect(result).toEqual({ assigned: false });
  });

  it("enabled but job has NO classification → falls back to first-fit (no regression)", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]); // active techs
    queueAutoAssignLeadIn(true);
    selectQueue.push([{ jobType: null, systemType: null, urgency: "standard" }]); // unclassified
    // rankedTechnicianOrder returns null → order = first-fit (DB order), no
    // confidence gate; T1 wins.
    queueSuccessfulPlacement(T1);

    const result = await autoAssignBookedRequest(ORG, REQ, HELD);
    expect(result).toEqual({ assigned: true, technicianId: T1 });
  });

  it("no active technicians → {assigned:false} without reading settings", async () => {
    selectQueue.push([]); // no active techs
    const result = await autoAssignBookedRequest(ORG, REQ, HELD);
    expect(result).toEqual({ assigned: false });
  });

  it("shadow: autopilot OFF but classifiable → records is_shadow decision, still first-fits", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]); // active techs
    queueAutoAssignLeadIn(false); // duration/external/flag=OFF (quality gate skipped)
    selectQueue.push([CLASSIFIED]); // rankedTechnicianOrder → classification (shadow)
    rankedState.order = [T2, T1]; // shadow ranker prefers T2
    queueSuccessfulPlacement(T1); // first-fit still places DB-order T1

    const result = await autoAssignBookedRequest(ORG, REQ, HELD);
    // First-fit outcome is unchanged (T1 wins), and a SHADOW decision was recorded.
    expect(result).toEqual({ assigned: true, technicianId: T1 });
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ isShadow: true }),
    );
  });

  it("shadow: autopilot OFF and UNCLASSIFIABLE → records nothing, first-fits", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]); // active techs
    queueAutoAssignLeadIn(false);
    selectQueue.push([{ jobType: null, systemType: null, urgency: "standard" }]); // unclassified
    queueSuccessfulPlacement(T1);

    const result = await autoAssignBookedRequest(ORG, REQ, HELD);
    expect(result).toEqual({ assigned: true, technicianId: T1 });
    expect(insertMock).not.toHaveBeenCalled(); // nothing recorded
  });

  it("shadow: rankedTechnicianOrder throws → first-fit still places, no decision insert", async () => {
    // Simulate a transient DB error in the signal-loading step inside the shadow
    // rankedTechnicianOrder call.  loadDispatchSignals is already vi.mock'd above;
    // reject the first call (shadow) and then restore normal behaviour for the
    // enabled=false path (which won't call it again for the first-fit fallback).
    const signalsMod = await import("@/lib/ai/dispatch/signals");
    vi.mocked(signalsMod.loadDispatchSignals).mockRejectedValueOnce(
      new Error("DB transient: connection reset"),
    );

    selectQueue.push([{ id: T1 }, { id: T2 }]); // active techs
    selectQueue.push([]); // ensureEstimatedDuration (concurrent with tech list)
    selectQueue.push([{ source: "native", autoDispatchEnabled: false }]); // merged settings read
    selectQueue.push([CLASSIFIED]); // loadJobClassification inside rankedTechnicianOrder
    // loadDispatchSignals throws → shadow block catches → first-fit runs below.
    queueSuccessfulPlacement(T1);

    const result = await autoAssignBookedRequest(ORG, REQ, HELD);
    expect(result).toEqual({ assigned: true, technicianId: T1 });
    expect(insertMock).not.toHaveBeenCalled(); // shadow failure → nothing recorded
  });
});

describe("visit-#1 guarded writers lock the request first", () => {
  const isLockThenUpdate = (count: number, marker: string) => {
    expect(batchMock).toHaveBeenCalledTimes(1);
    const statements = batchMock.mock.calls[0]![0] as unknown[];
    expect(statements).toHaveLength(count);
    expect(statements[0]).toHaveProperty("__lock");
    expect(JSON.stringify(whereCalls)).toContain(marker);
  };

  it("placeAndAssignRequest: [lock, guarded update (started rule), revive]", async () => {
    selectQueue.push([{ status: "scheduled", assignedTo: null }]);
    updateQueue.push([{ status: "scheduled", assignedTo: null, scheduledDate: new Date(), arrivalWindowStart: new Date(), arrivalWindowEnd: new Date() }]);
    const window = { start: new Date("2026-07-01T12:00:00.000Z"), end: new Date("2026-07-01T16:00:00.000Z") };
    const result = await placeAndAssignRequest(ORG, REQ, window, { isoDay: "2026-07-01", window: "morning" });
    expect(result.ok).toBe(true);
    isLockThenUpdate(3, "VISIT_ONE_STARTED_GUARD");
    const statements = batchMock.mock.calls[0]![0] as unknown[];
    expect((statements[2] as { __lock: unknown }).__lock).toBe("REVIVE_LEAD");
  });

  it("unscheduleRequest: [lock, guarded update] with the version gate, FieldPulse, started and work-logged guards", async () => {
    selectQueue.push([{ status: "assigned", fp: null }]);
    updateQueue.push([{ id: REQ }]);
    expect(await unscheduleRequest(ORG, REQ, { visitId: "v1", expectedVersion: 2 })).toEqual({ ok: true });
    isLockThenUpdate(2, "VISIT_ONE_STARTED_GUARD");
    const where = JSON.stringify(whereCalls);
    for (const marker of ["VERSION_GATE", "FIELDPULSE_FREE", "NO_WORK_LOGGED"]) expect(where).toContain(marker);
  });
});

describe("unscheduleRequest pins its tenant, request and status CAS", () => {
  it("the guarded update is org-scoped, by id, and CAS on the status read", async () => {
    selectQueue.push([{ status: "assigned", fp: null }]);
    updateQueue.push([{ id: REQ }]);
    await unscheduleRequest(ORG, REQ, { visitId: "v1", expectedVersion: 2 });
    const tenant = whereCalls[1][0] as { __tenant: string; conditions: unknown[] };
    expect(tenant.__tenant).toBe(ORG);
    const conds = JSON.stringify(tenant.conditions);
    expect(conds).toContain('["eq","sr.id","' + REQ + '"]');
    expect(conds).toContain('["eq","sr.status","assigned"]');
    expect(tenantOrgOf(0)).toBe(ORG);
  });
});

describe("unscheduleRequest refusals (spec §5.4)", () => {
  const gate = { visitId: "v1", expectedVersion: 2 };
  const miss = (row: Record<string, unknown>) => {
    selectQueue.push([{ status: "scheduled", fp: null }]);
    updateQueue.push([]);
    selectQueue.push([{ status: "scheduled", fieldpulse: false, versionOk: true, started: false, ended: false, workLogged: false, ...row }]);
    return unscheduleRequest(ORG, REQ, gate);
  };
  it("FieldPulse first, then STALE, started, ended, work logged", async () => {
    expect(await miss({ fieldpulse: true, versionOk: false })).toEqual({ ok: false, reason: "managed_externally" });
    expect(await miss({ versionOk: false, started: true })).toEqual({ ok: false, reason: "stale" });
    expect(await miss({ started: true, workLogged: true })).toEqual({ ok: false, reason: "has_progress" });
    expect(await miss({ ended: true })).toEqual({ ok: false, reason: "visit_ended" });
    expect(await miss({ workLogged: true })).toEqual({ ok: false, reason: "work_logged" });
    expect(await miss({})).toEqual({ ok: false, reason: "stale" });
  });
  it("terminal and not found are decided before the write", async () => {
    selectQueue.push([{ status: "completed", fp: null }]);
    expect(await unscheduleRequest(ORG, REQ, gate)).toEqual({ ok: false, reason: "request_terminal", currentStatus: "completed" });
    selectQueue.push([]);
    expect(await unscheduleRequest(ORG, REQ, gate)).toEqual({ ok: false, reason: "request_not_found" });
  });
});

describe("suggestTechnicians (retired demo users)", () => {
  const T1 = "00000000-0000-0000-0000-0000000000d1";
  const DEMO = "00000000-0000-0000-0000-0000000000d2";
  function queueSuggest(): void {
    selectQueue.push([
      { id: T1, email: "dana@spears.com" },
      { id: DEMO, email: "mike.johnson@demo-hvac.com" },
    ]); // active techs
    selectQueue.push([{ scheduledDate: new Date("2026-11-12T15:00:00Z") }]); // request day
    selectQueue.push([{ jobType: "no_cool", systemType: "central_ac", urgency: "standard" }]); // classification
  }

  it("never scores a retired demo technician for an org viewer", async () => {
    queueSuggest();
    rankedState.order = [T1];
    await suggestTechnicians(ORG, REQ, 3, VISIBLE_ONLY);
    expect(vi.mocked(loadDispatchSignals).mock.calls.at(-1)?.[1]).toEqual([T1]);
  });

  it("still scores them for the platform owner", async () => {
    queueSuggest();
    rankedState.order = [T1, DEMO];
    await suggestTechnicians(ORG, REQ, 3, SHOW_ALL);
    expect(vi.mocked(loadDispatchSignals).mock.calls.at(-1)?.[1]).toEqual([T1, DEMO]);
  });
});
