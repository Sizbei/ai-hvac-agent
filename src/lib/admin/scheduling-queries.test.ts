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
    insert: () => {
      insertMock();
      return chain([]);
    },
    batch: (...args: unknown[]) => batchMock(...args),
  },
}));

// isTerminal is the only request-status surface rescheduleRequest uses; mock it
// rather than pull the real enum (the schema mock omits requestStatusEnum).
vi.mock("./request-status", () => ({
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
}));

vi.mock("@/lib/db/schema", () => ({
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
}));

import {
  getTechnicianAvailability,
  setTechnicianAvailability,
  checkScheduleConflict,
  getScheduledJobsForRange,
  listUnscheduledRequests,
  rescheduleRequest,
  placeAndAssignRequest,
} from "./scheduling-queries";

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
  batchMock.mockResolvedValue([]);
});

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
  it("scopes to open statuses and surfaces a null window as empty string", async () => {
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
    const result = await listUnscheduledRequests(ORG);
    expect(result).toEqual([
      {
        id: "u1",
        referenceNumber: "REF-3",
        status: "pending",
        assignedTo: null,
        arrivalWindowStart: "",
        arrivalWindowEnd: "",
      },
    ]);
    const conds = (whereCalls[0][0] as { conditions: unknown[] }).conditions;
    const statusCond = conds.find(
      (c) => Array.isArray(c) && c[0] === "inArray" && c[1] === "sr.status",
    ) as unknown[];
    expect(statusCond[2]).toEqual(["pending", "scheduled"]);
    // "Unscheduled" = unassigned OR no window — an OR over the two null checks.
    expect(conds.some((c) => Array.isArray(c) && c[0] === "or")).toBe(true);
  });

  it("is tenant-isolated", async () => {
    selectQueue.push([]);
    await listUnscheduledRequests(OTHER_ORG);
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
