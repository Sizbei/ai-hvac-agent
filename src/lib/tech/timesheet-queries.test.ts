import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clockIn,
  clockOut,
  getActualLaborCostCents,
  openGeneralEntry,
  closeGeneralEntry,
  getOpenGeneralEntry,
} from "./timesheet-queries";
import { db } from "@/lib/db";
import { findReadableJob } from "@/lib/tech/ownership";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    // update().set().where() builds a query object that's only ever passed into
    // db.batch([...]) (never awaited directly), so the chain just returns itself.
    update: vi.fn(() => {
      const chain = {
        set: () => chain,
        where: () => chain,
      };
      return chain;
    }),
    batch: vi.fn(),
  },
}));

vi.mock("@/lib/tech/ownership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tech/ownership")>()),
  findReadableJob: vi.fn(),
  findActiveVisit: vi.fn(),
}));

const ORG = "org-1";
const TECH = "tech-1";
const JOB = "job-1";

/** Whether the technician can read/act on the job (the ownership module's answer). */
function owned(yes: boolean): void {
  vi.mocked(findReadableJob).mockResolvedValue(
    yes ? { id: JOB, customerId: null, native: true, status: "assigned" } : null,
  );
}

/**
 * Sequence db.select results. Each call returns a chain whose where() is BOTH
 * awaitable (for list reads) and .limit()-able (for guards/single-row reads).
 * Mirrors field-queries.test.ts.
 */
function mockSelectSeq(results: unknown[][]): void {
  let i = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const rows = results[i++] ?? [];
    const result = Promise.resolve(rows);
    return {
      from: () => ({
        where: () =>
          Object.assign(result, {
            limit: () => Promise.resolve(rows),
            orderBy: () => Promise.resolve(rows),
          }),
      }),
    } as never;
  });
}

beforeEach(() => vi.clearAllMocks());

describe("clockIn", () => {
  it("inserts an open entry when the tech owns the job and has none open", async () => {
    // 1) ownership guard -> owned; 2) open-entry check -> none
    owned(true);
    mockSelectSeq([[]]);
    const valuesSpy = vi.fn(() => ({
      returning: () => Promise.resolve([{ id: "tte-1" }]),
    }));
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);

    const r = await clockIn(ORG, TECH, JOB);
    expect(r).toEqual({ ok: true, id: "tte-1" });
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        serviceRequestId: JOB,
        technicianId: TECH,
      }),
    );
  });

  it("rejects a job not assigned to the tech (guard) before any write", async () => {
    // ownership guard returns no job -> not owned
    owned(false);
    const r = await clockIn(ORG, TECH, JOB);
    expect(r).toEqual({ ok: false, reason: "not_owned" });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects a double clock-in (an open entry already exists)", async () => {
    // 1) ownership guard -> owned; 2) open-entry check -> one already open
    owned(true);
    mockSelectSeq([[{ id: "tte-open" }]]);
    const r = await clockIn(ORG, TECH, JOB);
    expect(r).toEqual({ ok: false, reason: "already_open" });
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("clockOut", () => {
  // Pin "now" so elapsed minutes are deterministic.
  const NOW = new Date("2026-06-16T10:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes minutes + cost from the SNAPSHOTTED user rate", async () => {
    // clock-in 90 minutes ago.
    const clockInAt = new Date(NOW.getTime() - 90 * 60000);
    // 1) ownership guard -> owned
    // 2) open entry lookup -> the open entry
    // 3) user rate snapshot -> $60/hr = 6000 cents/hr
    owned(true);
    mockSelectSeq([
      [{ id: "tte-1", clockInAt }],
      [{ laborRateCents: 6000 }],
    ]);
    const batchSpy = vi.mocked(db.batch).mockResolvedValue([] as never);

    const r = await clockOut(ORG, TECH, JOB);
    // 90 min × 6000 c/hr = round(90/60 * 6000) = 9000 cents.
    expect(r).toEqual({
      ok: true,
      id: "tte-1",
      minutes: 90,
      laborCostCents: 9000,
    });
    expect(batchSpy).toHaveBeenCalledTimes(1);
  });

  it("treats a NULL/absent user rate as 0 (no labor cost)", async () => {
    const clockInAt = new Date(NOW.getTime() - 45 * 60000);
    owned(true);
    mockSelectSeq([
      [{ id: "tte-2", clockInAt }],
      [{ laborRateCents: null }],
    ]);
    vi.mocked(db.batch).mockResolvedValue([] as never);

    const r = await clockOut(ORG, TECH, JOB);
    expect(r).toEqual({
      ok: true,
      id: "tte-2",
      minutes: 45,
      laborCostCents: 0,
    });
  });

  it("rejects a job not assigned to the tech (guard) before any write", async () => {
    owned(false);
    const r = await clockOut(ORG, TECH, JOB);
    expect(r).toEqual({ ok: false, reason: "not_owned" });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("returns no_open_entry when the tech isn't clocked in", async () => {
    // 1) ownership guard -> owned; 2) open entry lookup -> none
    owned(true);
    mockSelectSeq([[]]);
    const r = await clockOut(ORG, TECH, JOB);
    expect(r).toEqual({ ok: false, reason: "no_open_entry" });
    expect(db.batch).not.toHaveBeenCalled();
  });
});

describe("getActualLaborCostCents", () => {
  it("sums laborCostCents of CLOSED entries only (open entries are null → 0)", async () => {
    mockSelectSeq([
      [
        { laborCostCents: 9000 }, // closed
        { laborCostCents: 3000 }, // closed
        { laborCostCents: null }, // still open → 0
      ],
    ]);
    const total = await getActualLaborCostCents(ORG, JOB);
    expect(total).toBe(12000);
  });

  it("is 0 when there are no entries", async () => {
    mockSelectSeq([[]]);
    const total = await getActualLaborCostCents(ORG, JOB);
    expect(total).toBe(0);
  });
});

describe("general clock", () => {
  const NOW = new Date("2026-06-16T10:00:00.000Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("opens a general entry with no request, manual method", async () => {
    const valuesSpy = vi.fn(() => ({ returning: () => Promise.resolve([{ id: "g-1" }]) }));
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);
    expect(await openGeneralEntry(ORG, TECH)).toEqual({ ok: true, id: "g-1" });
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        technicianId: TECH,
        kind: "general",
        serviceRequestId: null,
        clockInMethod: "manual",
      }),
    );
  });

  it("maps the open-general unique violation to already_open", async () => {
    const err = Object.assign(new Error("dup"), { code: "23505", constraint: "tte_open_general_per_tech_idx" });
    vi.mocked(db.insert).mockReturnValue({
      values: () => ({ returning: () => Promise.reject(err) }),
    } as never);
    expect(await openGeneralEntry(ORG, TECH)).toEqual({ ok: false, reason: "already_open" });
  });

  it("rethrows other insert errors", async () => {
    vi.mocked(db.insert).mockReturnValue({
      values: () => ({ returning: () => Promise.reject(new Error("boom")) }),
    } as never);
    await expect(openGeneralEntry(ORG, TECH)).rejects.toThrow("boom");
  });

  it("getOpenGeneralEntry returns the open row or null", async () => {
    const clockInAt = new Date("2026-06-16T09:00:00.000Z");
    mockSelectSeq([[{ id: "g-1", clockInAt }]]);
    expect(await getOpenGeneralEntry(ORG, TECH)).toEqual({ id: "g-1", clockInAt });
    mockSelectSeq([[]]);
    expect(await getOpenGeneralEntry(ORG, TECH)).toBeNull();
  });

  it("closes with minutes only: rate 0, cost left NULL", async () => {
    mockSelectSeq([[{ id: "g-1", clockInAt: new Date("2026-06-16T08:30:30.000Z") }]]);
    const setSpy = vi.fn(() => ({ where: () => ({ returning: () => ({}) }) }));
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as never);
    vi.mocked(db.batch).mockResolvedValue([[{ id: "g-1" }]] as never);
    const r = await closeGeneralEntry(ORG, TECH);
    expect(r).toEqual({ ok: true, id: "g-1", minutes: 89 });
    const set = (setSpy.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(set.minutes).toBe(89);
    expect(set.laborRateCents).toBe(0);
    expect(set).not.toHaveProperty("laborCostCents");
  });

  it("returns not_open when a concurrent clock-out won the guarded update", async () => {
    mockSelectSeq([[{ id: "g-1", clockInAt: new Date("2026-06-16T08:30:30.000Z") }]]);
    vi.mocked(db.update).mockReturnValue({ set: () => ({ where: () => ({ returning: () => ({}) }) }) } as never);
    vi.mocked(db.batch).mockResolvedValue([[]] as never);
    expect(await closeGeneralEntry(ORG, TECH)).toEqual({ ok: false, reason: "not_open" });
  });

  it("returns no_open_entry when nothing is open", async () => {
    mockSelectSeq([[]]);
    expect(await closeGeneralEntry(ORG, TECH)).toEqual({ ok: false, reason: "no_open_entry" });
    expect(db.batch).not.toHaveBeenCalled();
  });
});
