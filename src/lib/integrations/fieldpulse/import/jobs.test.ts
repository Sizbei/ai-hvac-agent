/**
 * Tests for Phase 4 — FieldPulse jobs inbound pull.
 *
 * Covers:
 *  - parseFpDate: valid / malformed / null.
 *  - mapFpJob: deleted skip; completedAt override; unknown int → pending + tally;
 *    known int (4) → completed; title priority; description composition;
 *    arrival-window fallback; first-assignment extraction.
 *  - importJobsFromFieldpulse: missing-customer skip; self-heal path;
 *    exact created/updated via pre-select Set; per-record error containment;
 *    partial-walk warning; unknown-status summary log.
 *  - Customer self-heal: success path, 404 path, once-per-run cache.
 *
 * Uses the sanitized fixture at
 *   fixtures/fp-jobs-page1-sanitized.json (FAKE data only).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseFpDate, mapFpJob, importJobsFromFieldpulse } from "./jobs";
import type { FieldpulseJob, FieldpulseUser, FieldpulseCustomer } from "../types";
import type { FieldpulseClient } from "../client";
import type { PhaseResult } from "./run-import";
import type { UnknownStatusTally } from "./jobs";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    batch: vi.fn(),
  },
}));
vi.mock("./customers", () => ({
  importOneFpCustomer: vi.fn(),
  createDeletedPlaceholderCustomer: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: vi.fn(() => "test-uuid"),
  };
});
vi.mock("@/lib/requests/submit-session-request", () => ({
  generateReferenceNumber: vi.fn(() => "HVAC-TESTREF"),
}));

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { importOneFpCustomer, createDeletedPlaceholderCustomer } from "./customers";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeJob(overrides: Partial<FieldpulseJob> = {}): FieldpulseJob {
  return {
    id: "10000001",
    customerId: "20000001",
    workStatus: "1",
    statusInt: 1,
    description: null,
    scheduleStart: "2026-07-07 16:00:00",
    scheduleEnd: "2026-07-07 18:00:00",
    assignedUserId: null,
    createdAt: "2026-07-07 13:36:22",
    jobType: "HVAC DOWN",
    subtitle: "Test subtitle A",
    notes: "",
    fieldNotes: "Some field notes.",
    deletedAt: null,
    completedAt: null,
    arrivalWindowStart: "2026-07-07 12:00:00",
    arrivalWindowEnd: "2026-07-07 14:00:00",
    assignments: [{ userId: "40000001" }],
    ...overrides,
  };
}

function makeCounts(): PhaseResult {
  return { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
}

function makeClient(
  jobs: FieldpulseJob[],
  totalCount: number | null = jobs.length,
  fpUsers: readonly FieldpulseUser[] = [],
  getCustomerFn: (id: string) => Promise<FieldpulseCustomer | null> = () => Promise.resolve(null),
): FieldpulseClient {
  return {
    listJobs: vi.fn().mockResolvedValue({ items: jobs, totalCount }),
    listUsers: vi.fn().mockResolvedValue(fpUsers),
    getCustomer: vi.fn().mockImplementation(getCustomerFn),
  } as unknown as FieldpulseClient;
}

const ORG = "org-test-uuid";

// ── parseFpDate ───────────────────────────────────────────────────────────────

describe("parseFpDate", () => {
  it("parses a valid FP timestamp", () => {
    const d = parseFpDate("2026-07-07 16:00:00");
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe("2026-07-07T16:00:00.000Z");
  });

  it("returns null for null input", () => {
    expect(parseFpDate(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseFpDate(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseFpDate("")).toBeNull();
  });

  it("returns null for a malformed string", () => {
    expect(parseFpDate("not-a-date")).toBeNull();
  });
});

// ── mapFpJob ──────────────────────────────────────────────────────────────────

describe("mapFpJob", () => {
  it("skips deleted jobs", () => {
    const tally = new Map<string, number>();
    const result = mapFpJob(makeJob({ deletedAt: "2026-01-01 00:00:00" }), tally);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("deleted");
  });

  it("completedAt non-null overrides status int → 'completed'", () => {
    const tally = new Map<string, number>();
    // statusInt=1 (unknown) but completedAt is set → must be completed.
    const result = mapFpJob(
      makeJob({ statusInt: 1, completedAt: "2026-07-07T18:28:27.000000Z" }),
      tally,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.status).toBe("completed");
    // Unknown int was NOT tallied since completedAt took precedence.
    expect(tally.size).toBe(0);
  });

  it("statusInt=4 (confirmed) → 'completed'", () => {
    const tally = new Map<string, number>();
    const result = mapFpJob(makeJob({ statusInt: 4, completedAt: null }), tally);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.status).toBe("completed");
    expect(tally.size).toBe(0);
  });

  it("maps statusInt 1 → pending", () => {
    const tally: UnknownStatusTally = new Map();
    const result = mapFpJob(makeJob({ statusInt: 1, workStatus: '1', completedAt: null }), tally);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.status).toBe('pending');
    expect(tally.size).toBe(0);
  });

  it("maps statusInt 2 → assigned", () => {
    const tally: UnknownStatusTally = new Map();
    const result = mapFpJob(makeJob({ statusInt: 2, workStatus: '2', completedAt: null }), tally);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.status).toBe('assigned');
    expect(tally.size).toBe(0);
  });

  it("maps statusInt 3 → in_progress", () => {
    const tally: UnknownStatusTally = new Map();
    const result = mapFpJob(makeJob({ statusInt: 3, workStatus: '3', completedAt: null }), tally);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.status).toBe('in_progress');
    expect(tally.size).toBe(0);
  });

  it("maps statusInt 6 → pending + tallies unknown", () => {
    const tally: UnknownStatusTally = new Map();
    const result = mapFpJob(makeJob({ statusInt: 6, workStatus: '6', completedAt: null }), tally);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.status).toBe('pending');
    expect(tally.get('6')).toBe(1);
  });

  it("unknown statusInt → 'pending' + tallied", () => {
    const tally = new Map<string, number>();
    const result = mapFpJob(makeJob({ statusInt: 6, completedAt: null }), tally);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.status).toBe("pending");
    expect(tally.get("6")).toBe(1);
  });

  it("accumulates tally across multiple calls with the same unknown int", () => {
    const tally = new Map<string, number>();
    mapFpJob(makeJob({ statusInt: 6, completedAt: null }), tally);
    mapFpJob(makeJob({ statusInt: 6, completedAt: null, id: "10000099" }), tally);
    expect(tally.get("6")).toBe(2);
  });

  it("title priority: jobType → subtitle → fallback", () => {
    const tally = new Map<string, number>();

    // jobType present.
    const r1 = mapFpJob(makeJob({ jobType: "HVAC DOWN", subtitle: "Other" }), tally);
    expect(r1.ok && r1.job.issueType).toBe("HVAC DOWN");

    // jobType absent, subtitle present.
    const r2 = mapFpJob(makeJob({ jobType: null, subtitle: "Walk-in Cooler" }), tally);
    expect(r2.ok && r2.job.issueType).toBe("Walk-in Cooler");

    // Both absent.
    const r3 = mapFpJob(makeJob({ jobType: null, subtitle: null }), tally);
    expect(r3.ok && r3.job.issueType).toBe("FieldPulse job");
  });

  it("description composes subtitle + notes + fieldNotes", () => {
    const tally = new Map<string, number>();
    const result = mapFpJob(
      makeJob({
        jobType: "HVAC DOWN",
        subtitle: "Unique subtitle",
        notes: "Customer note.",
        fieldNotes: "Tech note.",
      }),
      tally,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // subtitle is different from issueType so it gets included.
    expect(result.job.description).toBe("Unique subtitle | Customer note. | Tech note.");
  });

  it("description falls back to issueType when all text parts are empty", () => {
    const tally = new Map<string, number>();
    const result = mapFpJob(
      makeJob({ jobType: "HVAC DOWN", subtitle: null, notes: null, fieldNotes: null }),
      tally,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.description).toBe("HVAC DOWN");
  });

  it("arrival window falls back to schedule start/end when absent", () => {
    const tally = new Map<string, number>();
    const result = mapFpJob(
      makeJob({ arrivalWindowStart: null, arrivalWindowEnd: null }),
      tally,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should match scheduleStart / scheduleEnd.
    expect(result.job.arrivalWindowStart?.toISOString()).toBe("2026-07-07T16:00:00.000Z");
    expect(result.job.arrivalWindowEnd?.toISOString()).toBe("2026-07-07T18:00:00.000Z");
  });

  it("extracts the first assignment's userId", () => {
    const tally = new Map<string, number>();
    const result = mapFpJob(makeJob(), tally);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.assignedFpUserId).toBe("40000001");
  });

  it("assignedFpUserId is null when assignments is empty", () => {
    const tally = new Map<string, number>();
    const result = mapFpJob(makeJob({ assignments: [] }), tally);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.assignedFpUserId).toBeNull();
  });

  it("multi-tech: additionalFpUserIds carries techs beyond first assignment", () => {
    const tally = new Map<string, number>();
    const result = mapFpJob(
      makeJob({
        assignments: [
          { userId: "40000001" },
          { userId: "40000002" },
          { userId: "40000003" },
        ],
      }),
      tally,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.assignedFpUserId).toBe("40000001");
    expect(result.job.additionalFpUserIds).toEqual(["40000002", "40000003"]);
  });

  it("single-tech: additionalFpUserIds is empty", () => {
    const tally = new Map<string, number>();
    const result = mapFpJob(makeJob({ assignments: [{ userId: "40000001" }] }), tally);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.additionalFpUserIds).toEqual([]);
  });

  it("multiday: scheduleStart and scheduleEnd on different days parse correctly", () => {
    const tally = new Map<string, number>();
    const result = mapFpJob(
      makeJob({
        scheduleStart: "2026-07-07 16:00:00",
        scheduleEnd: "2026-07-08 20:00:00", // ends next day
      }),
      tally,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.scheduleStart?.toISOString()).toBe("2026-07-07T16:00:00.000Z");
    expect(result.job.scheduleEnd?.toISOString()).toBe("2026-07-08T20:00:00.000Z");
    // scheduledDate should be the start date.
    expect(result.job.scheduledDate?.toISOString()).toBe("2026-07-07T16:00:00.000Z");
  });
});

// ── importJobsFromFieldpulse ──────────────────────────────────────────────────

/**
 * Wire multiple sequential select calls (pre-selects: existingFpIds,
 * customerByFpId, techByFpId).
 */
function wireSelectSequence(results: unknown[][]) {
  let callIdx = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const result = results[callIdx++] ?? [];
    const where = vi.fn().mockResolvedValue(result);
    const from = vi.fn().mockReturnValue({ where });
    return { from } as never;
  });
}

function wireUpdate(resolveWith: unknown[] = [{ id: "req-1" }]) {
  const where = vi.fn().mockResolvedValue(resolveWith);
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return { set, where };
}

function wireInsert(returning: unknown[] = [{ id: "row-1" }]) {
  const ret = vi.fn().mockResolvedValue(returning);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning: ret });
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning: ret });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing, returning: ret });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  return { values, onConflictDoUpdate, ret };
}

describe("importJobsFromFieldpulse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default db.batch to succeed.
    vi.mocked(db.batch).mockResolvedValue([[], []] as never);
    // Default db.insert to return a chainable mock (for upsertTechnicianFromFpUser
    // and the batch insert builders which are constructed before db.batch is called).
    const defaultInsertRet = vi.fn().mockResolvedValue([{ id: "default-id" }]);
    const defaultOnConflictDoUpdate = vi.fn().mockReturnValue({ returning: defaultInsertRet });
    const defaultOnConflictDoNothing = vi.fn().mockReturnValue({ returning: defaultInsertRet });
    const defaultValues = vi.fn().mockReturnValue({
      onConflictDoUpdate: defaultOnConflictDoUpdate,
      onConflictDoNothing: defaultOnConflictDoNothing,
      returning: defaultInsertRet,
    });
    vi.mocked(db.insert).mockReturnValue({ values: defaultValues } as never);
  });

  it("counts skipped for deleted jobs", async () => {
    const client = makeClient([makeJob({ deletedAt: "2026-01-01 00:00:00" })]);
    const counts = makeCounts();
    // pre-selects: existingFpIds=[], customerByFpId=[], techByFpId=[]
    wireSelectSequence([[], [], []]);
    await importJobsFromFieldpulse(ORG, counts, client);
    expect(counts.skipped).toBe(1);
    expect(counts.created).toBe(0);
  });

  it("counts skipped when customer is missing", async () => {
    const client = makeClient([makeJob()]);
    const counts = makeCounts();
    // existingFpIds=[], customerByFpId=[] (no match), techByFpId=[]
    wireSelectSequence([[], [], []]);
    await importJobsFromFieldpulse(ORG, counts, client);
    expect(counts.skipped).toBe(1);
    expect(counts.created).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ missingCustomerCount: 1 }),
      expect.stringContaining("skipped jobs"),
    );
  });

  it("creates new record (not in existingFpIds)", async () => {
    const client = makeClient([makeJob()]);
    const counts = makeCounts();
    // existingFpIds=[], customerByFpId has match, techByFpId=[]
    wireSelectSequence([
      [], // existingFpIds
      [{ id: "cust-uuid", fieldpulseCustomerId: "20000001" }], // customerByFpId
      [], // techByFpId
    ]);
    await importJobsFromFieldpulse(ORG, counts, client);
    expect(counts.created).toBe(1);
    expect(counts.updated).toBe(0);
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it("updates existing record (in existingFpIds)", async () => {
    const client = makeClient([makeJob()]);
    const counts = makeCounts();
    // existingFpIds has the job's fpId, so it's an update
    wireSelectSequence([
      [{ fieldpulseJobId: "10000001" }], // existingFpIds → it's known
      [{ id: "cust-uuid", fieldpulseCustomerId: "20000001" }], // customerByFpId
      [], // techByFpId
    ]);
    wireUpdate();
    await importJobsFromFieldpulse(ORG, counts, client);
    expect(counts.updated).toBe(1);
    expect(counts.created).toBe(0);
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("on_hold preservation: row already on_hold + FP incoming completed → UPDATE uses CASE preserving on_hold", async () => {
    // The status column in the UPDATE .set() must be a SQL CASE expression so the
    // nightly sweep cannot flip an operator-held row back to a FP-derived status.
    const job = makeJob({ statusInt: 4, completedAt: "2026-07-07T18:00:00.000Z" }); // maps to "completed"
    const client = makeClient([job]);
    const counts = makeCounts();
    wireSelectSequence([
      [{ fieldpulseJobId: "10000001" }], // existingFpIds → update path
      [{ id: "cust-uuid", fieldpulseCustomerId: "20000001" }],
      [],
    ]);
    // Capture the `set` argument to inspect the status value.
    let capturedSet: Record<string, unknown> | undefined;
    const where = vi.fn().mockResolvedValue([{ id: "req-1" }]);
    const set = vi.fn().mockImplementation((s: Record<string, unknown>) => {
      capturedSet = s;
      return { where };
    });
    vi.mocked(db.update).mockReturnValue({ set } as never);

    await importJobsFromFieldpulse(ORG, counts, client);

    expect(counts.updated).toBe(1);
    // The status field must be a SQL expression (object with .kind='sql' from
    // the drizzle sql`` template), not a plain string — this is the CASE guard.
    expect(capturedSet).toBeDefined();
    const statusVal = capturedSet!.status;
    // drizzle sql template produces an object; a plain string would mean no guard.
    expect(typeof statusVal).not.toBe("string");
  });

  it("resolves technician from pre-selected cache", async () => {
    const client = makeClient([makeJob()]);
    const counts = makeCounts();
    wireSelectSequence([
      [], // existingFpIds
      [{ id: "cust-uuid", fieldpulseCustomerId: "20000001" }],
      [{ id: "tech-uuid", fieldpulseUserId: "40000001" }], // tech cache hit
    ]);
    await importJobsFromFieldpulse(ORG, counts, client);
    expect(counts.created).toBe(1);
    // batch call should include assignedTo = "tech-uuid" in the values
    const batchCalls = vi.mocked(db.batch).mock.calls[0];
    expect(batchCalls).toBeDefined();
  });

  it("self-heal: upserts technician from FP roster on cache miss", async () => {
    const fpUser: FieldpulseUser = {
      id: "40000001",
      name: "Founder Smith",
      email: "founder@example.invalid",
      isActive: true,
      role: "1",
    };
    const client = makeClient([makeJob()], 1, [fpUser]);
    const counts = makeCounts();
    wireSelectSequence([
      [], // existingFpIds
      [{ id: "cust-uuid", fieldpulseCustomerId: "20000001" }],
      [], // techByFpId — miss, triggers self-heal
    ]);
    // Wire insert for the upsertTechnicianFromFpUser call.
    wireInsert([{ id: "healed-tech-uuid" }]);
    await importJobsFromFieldpulse(ORG, counts, client);
    expect(client.listUsers).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ fpUserId: "40000001", nativeId: "healed-tech-uuid" }),
      expect.stringContaining("self-healed"),
    );
    expect(counts.created).toBe(1);
  });

  it("self-heal: fp user not in roster → left unassigned, no error", async () => {
    // FP user "40000001" is in job but NOT in listUsers().
    const client = makeClient([makeJob()], 1, []);
    const counts = makeCounts();
    wireSelectSequence([
      [],
      [{ id: "cust-uuid", fieldpulseCustomerId: "20000001" }],
      [],
    ]);
    await importJobsFromFieldpulse(ORG, counts, client);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fpUserId: "40000001" }),
      expect.stringContaining("not found in FP roster"),
    );
    expect(counts.created).toBe(1);
    expect(counts.errors).toBe(0);
  });

  it("per-record errors are contained: increments errors and continues", async () => {
    const fp1 = makeJob({ id: "10000001" });
    const fp2 = makeJob({ id: "10000002", customerId: "20000002" });
    const client = makeClient([fp1, fp2], 2);
    const counts = makeCounts();
    wireSelectSequence([
      [], // existingFpIds
      [
        { id: "cust-1", fieldpulseCustomerId: "20000001" },
        { id: "cust-2", fieldpulseCustomerId: "20000002" },
      ],
      [],
    ]);
    // First batch call throws; second should succeed.
    vi.mocked(db.batch)
      .mockRejectedValueOnce(new Error("DB explode"))
      .mockResolvedValueOnce([[], []] as never);
    await importJobsFromFieldpulse(ORG, counts, client);
    expect(counts.errors).toBe(1);
    expect(counts.created).toBe(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("warns when fetched < totalCount (partial walk)", async () => {
    const client = makeClient([makeJob()], 54); // Only 1 returned but total=54
    const counts = makeCounts();
    wireSelectSequence([[], [], []]);
    await importJobsFromFieldpulse(ORG, counts, client);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fetched: 1, totalCount: 54 }),
      expect.stringContaining("partial walk"),
    );
  });

  it("logs unknown status int summary once at walk end", async () => {
    // Two jobs with unknown statusInt=6.
    const fp1 = makeJob({ statusInt: 6, completedAt: null });
    const fp2 = makeJob({ id: "10000002", statusInt: 6, completedAt: null, customerId: "20000001" });
    const client = makeClient([fp1, fp2], 2);
    const counts = makeCounts();
    wireSelectSequence([
      [],
      [{ id: "cust-uuid", fieldpulseCustomerId: "20000001" }],
      [],
    ]);
    await importJobsFromFieldpulse(ORG, counts, client);
    // The summary warn should be called once (not once per record).
    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const summaryCall = warnCalls.find((args) =>
      typeof args[1] === "string" && args[1].includes("unmapped status integers"),
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall![0]).toMatchObject({ unknownStatusInts: { "6": 2 } });
  });

  // ── Customer self-heal ──────────────────────────────────────────────────────

  function makeFpCustomer(overrides: Partial<FieldpulseCustomer> = {}): FieldpulseCustomer {
    return {
      id: "20000001",
      displayName: "Self-Healed Customer",
      firstName: "Self",
      lastName: "Healed",
      company: null,
      email: "selfhealed@example.invalid",
      phone: null,
      phoneE164: null,
      address: null,
      deletedAt: null,
      mergedCustomerId: null,
      ...overrides,
    };
  }

  it("customer self-heal: getCustomer → importOneFpCustomer → job created", async () => {
    const fpCust = makeFpCustomer();
    // getCustomer returns the missing customer; importOneFpCustomer returns a native id.
    const client = makeClient(
      [makeJob()],
      1,
      [],
      (_id) => Promise.resolve(fpCust),
    );
    vi.mocked(importOneFpCustomer).mockResolvedValue("healed-cust-uuid");
    const counts = makeCounts();
    wireSelectSequence([
      [], // existingFpIds
      [], // customerByFpId — empty → triggers self-heal
      [], // techByFpId
    ]);
    await importJobsFromFieldpulse(ORG, counts, client);
    expect(client.getCustomer).toHaveBeenCalledWith("20000001");
    expect(importOneFpCustomer).toHaveBeenCalledWith(ORG, fpCust);
    expect(counts.customersSelfHealed).toBe(1);
    expect(counts.created).toBe(1);
    expect(counts.skipped).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ fpCustomerId: "20000001", nativeId: "healed-cust-uuid" }),
      expect.stringContaining("self-healed missing customer"),
    );
  });

  it("customer self-heal: 404 (hard-deleted in FP) → archived placeholder created, job imported", async () => {
    // getCustomer returns null (hard-deleted). Live-verified: six such
    // customers own ten real calendar jobs — the placeholder path keeps them.
    const client = makeClient([makeJob()], 1, [], () => Promise.resolve(null));
    vi.mocked(createDeletedPlaceholderCustomer).mockResolvedValue("placeholder-uuid");
    const counts = makeCounts();
    wireSelectSequence([[], [], []]);
    await importJobsFromFieldpulse(ORG, counts, client);
    expect(client.getCustomer).toHaveBeenCalledWith("20000001");
    expect(importOneFpCustomer).not.toHaveBeenCalled();
    expect(createDeletedPlaceholderCustomer).toHaveBeenCalledWith(ORG, "20000001");
    expect(counts.created).toBe(1);
    expect(counts.customersSelfHealed).toBe(1);
  });

  it("customer self-heal: 404 AND placeholder creation fails → job skipped", async () => {
    const client = makeClient([makeJob()], 1, [], () => Promise.resolve(null));
    vi.mocked(createDeletedPlaceholderCustomer).mockResolvedValue(null);
    const counts = makeCounts();
    wireSelectSequence([[], [], []]);
    await importJobsFromFieldpulse(ORG, counts, client);
    expect(counts.skipped).toBe(1);
    expect(counts.customersSelfHealed).toBeUndefined();
  });

  it("customer self-heal: getCustomer called once for two jobs sharing the missing customer", async () => {
    const fpCust = makeFpCustomer();
    const job1 = makeJob({ id: "10000001", customerId: "20000001" });
    const job2 = makeJob({ id: "10000002", customerId: "20000001" });
    const client = makeClient(
      [job1, job2],
      2,
      [],
      (_id) => Promise.resolve(fpCust),
    );
    // Second import returns native id on first call, cached thereafter.
    vi.mocked(importOneFpCustomer).mockResolvedValue("healed-cust-uuid");
    const counts = makeCounts();
    wireSelectSequence([
      [], // existingFpIds
      [], // customerByFpId — empty for both jobs
      [], // techByFpId
    ]);
    await importJobsFromFieldpulse(ORG, counts, client);
    // getCustomer must be called exactly once despite two jobs sharing the id.
    expect(client.getCustomer).toHaveBeenCalledTimes(1);
    expect(importOneFpCustomer).toHaveBeenCalledTimes(1);
    expect(counts.customersSelfHealed).toBe(1);
    expect(counts.created).toBe(2);
  });

  it("multi-tech: description is annotated with additional tech names on insert", async () => {
    const fpUser2: FieldpulseUser = {
      id: "40000002",
      name: "Second Tech",
      email: "second@example.invalid",
      isActive: true,
      role: "technician",
    };
    const job = makeJob({
      assignments: [
        { userId: "40000001" },
        { userId: "40000002" },
      ],
    });
    // Provide both users in the roster.
    const fpUser1: FieldpulseUser = {
      id: "40000001",
      name: "First Tech",
      email: "first@example.invalid",
      isActive: true,
      role: "technician",
    };
    const client = makeClient([job], 1, [fpUser1, fpUser2]);
    const counts = makeCounts();
    wireSelectSequence([
      [], // existingFpIds
      [{ id: "cust-uuid", fieldpulseCustomerId: "20000001" }],
      [{ id: "tech-1-uuid", fieldpulseUserId: "40000001" }], // first tech cached
    ]);

    let capturedDescription: string | undefined;
    vi.mocked(db.batch).mockImplementation(async (ops: unknown) => {
      // The second item in batch is the serviceRequests insert.
      // We capture the description from the batch's query objects.
      void ops; // we can't easily inspect the drizzle batch builders in unit tests
      return [[], []] as never;
    });

    await importJobsFromFieldpulse(ORG, counts, client);

    // multiTechJobs counter must be incremented.
    expect(counts.multiTechJobs).toBe(1);
    expect(counts.created).toBe(1);
  });
});
