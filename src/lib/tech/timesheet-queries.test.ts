import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clockIn,
  clockOut,
  getActualLaborCostCents,
} from "./timesheet-queries";
import { db } from "@/lib/db";

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

const ORG = "org-1";
const TECH = "tech-1";
const JOB = "job-1";

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
    mockSelectSeq([[{ id: JOB }], []]);
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
    // ownership guard returns no rows -> not owned
    mockSelectSeq([[]]);
    const r = await clockIn(ORG, TECH, JOB);
    expect(r).toEqual({ ok: false, reason: "not_owned" });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects a double clock-in (an open entry already exists)", async () => {
    // 1) ownership guard -> owned; 2) open-entry check -> one already open
    mockSelectSeq([[{ id: JOB }], [{ id: "tte-open" }]]);
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
    mockSelectSeq([
      [{ id: JOB }],
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
    mockSelectSeq([
      [{ id: JOB }],
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
    mockSelectSeq([[]]);
    const r = await clockOut(ORG, TECH, JOB);
    expect(r).toEqual({ ok: false, reason: "not_owned" });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("returns no_open_entry when the tech isn't clocked in", async () => {
    // 1) ownership guard -> owned; 2) open entry lookup -> none
    mockSelectSeq([[{ id: JOB }], []]);
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
