import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  planVisitsForMembership,
  generateDueVisits,
} from "./membership-visit-queries";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
  },
}));

const ORG = "org-1";

/**
 * Sequence db.select results. The active-membership read chains
 * .from().innerJoin().innerJoin().where() (awaited directly); the existing-visit
 * read chains .from().where() (awaited directly). Each `where` resolves the next
 * queued result and is also .limit()-able (the recovery path uses .limit()).
 */
function mockSelectSeq(results: unknown[][]) {
  let i = 0;
  const where = () => {
    const r = results[i++] ?? [];
    const p = Promise.resolve(r);
    return Object.assign(p, {
      limit: () => Promise.resolve(r),
      orderBy: () => Promise.resolve(r),
    });
  };
  const innerJoin = () => ({ innerJoin, where });
  const from = () => ({ innerJoin, where });
  vi.mocked(db.select).mockImplementation(() => ({ from }) as never);
}

/**
 * Mock the claim insert. `returning` resolves to the given rows: a non-empty
 * array = the slot was claimed (proceed to create the job); [] = conflict
 * (already claimed → skip).
 */
function mockClaim(returningRows: unknown[]) {
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue(returningRows),
      })),
    })),
  } as never);
}

/** An active-membership join row as returned by generateDueVisits' first select. */
function activeMembershipRow(overrides: Record<string, unknown> = {}) {
  return {
    membershipId: "mem-1",
    // Cycle anchor; with visitsPerYear=2 the first visit is due on this date.
    startedAt: new Date("2026-01-01T00:00:00Z"),
    currentPeriodEnd: new Date("2027-01-01T00:00:00Z"),
    customerId: "cust-1",
    visitsPerYear: 2,
    planName: "Comfort Club",
    customerNameEncrypted: "enc-name",
    customerAddressEncrypted: "enc-addr",
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

// ───────────────────────── planVisitsForMembership (pure) ─────────────────────────

describe("planVisitsForMembership", () => {
  it("returns no visits for a billing-only plan (visitsPerYear=0)", () => {
    const visits = planVisitsForMembership(
      ORG,
      { id: "m", startedAt: new Date("2026-01-01Z"), currentPeriodEnd: null },
      { visitsPerYear: 0 },
      new Date("2026-06-01Z"),
    );
    expect(visits).toHaveLength(0);
  });

  it("spreads N visits evenly across the cycle with stable period keys", () => {
    const visits = planVisitsForMembership(
      ORG,
      {
        id: "m",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        currentPeriodEnd: null,
      },
      { visitsPerYear: 2 },
      new Date("2026-03-01T00:00:00Z"),
    );
    expect(visits).toHaveLength(2);
    expect(visits.map((v) => v.periodKey)).toEqual(["2026-V1", "2026-V2"]);
    // First at the anniversary, second ~6 months later.
    expect(visits[0]!.dueDate.getUTCMonth()).toBe(0); // Jan
    expect(visits[1]!.dueDate.getUTCMonth()).toBe(6); // Jul
  });
});

// ───────────────────────── generateDueVisits ─────────────────────────

describe("generateDueVisits", () => {
  it("creates a visit + service request in ONE batch for an in-window member", async () => {
    // now = early Jan: the V1 visit (due Jan 1) is within the 30-day window.
    const now = new Date("2026-01-05T00:00:00Z");
    // 1) active memberships, 2) existing generated visits (none).
    mockSelectSeq([[activeMembershipRow()], []]);
    mockClaim([{ id: "visit-1" }]); // claim succeeds

    const r = await generateDueVisits(ORG, now, { withinDays: 30 });

    expect(r.scanned).toBe(1);
    expect(r.generated).toBe(1);
    // The session + service request + back-link go through ONE batch.
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a second run for the same period does not duplicate", async () => {
    const now = new Date("2026-01-05T00:00:00Z");
    // The existing-visit pre-filter already finds V1 as generated → skipped,
    // V2 (due Jul) is outside the 30-day window. Nothing to generate.
    mockSelectSeq([[activeMembershipRow()], [{ periodKey: "2026-V1" }]]);
    mockClaim([{ id: "should-not-be-used" }]);

    const r = await generateDueVisits(ORG, now, { withinDays: 30 });

    expect(r.generated).toBe(0);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("idempotent via the unique-claim path when a concurrent run already claimed", async () => {
    const now = new Date("2026-01-05T00:00:00Z");
    // Pre-filter sees nothing generated, but the claim insert conflicts ([]),
    // and the recovery lookup finds the slot already 'generated' → skip.
    mockSelectSeq([[activeMembershipRow()], [], [{ id: "v", status: "generated" }]]);
    mockClaim([]); // onConflictDoNothing → no row returned (lost the race)

    const r = await generateDueVisits(ORG, now, { withinDays: 30 });

    expect(r.generated).toBe(0);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("reads the AUTHORITATIVE customerMemberships join (not the customers cache)", async () => {
    // The active-membership read is the FIRST select and drives generation. We
    // assert the query is built from the customerMemberships+plans+customers
    // join (status='active', visitsPerYear>0) — never customers.membershipStatus.
    const now = new Date("2026-01-05T00:00:00Z");
    const fromSpy = vi.fn();
    let firstSelect = true;
    vi.mocked(db.select).mockImplementation(() => {
      if (firstSelect) {
        firstSelect = false;
        const where = () => Promise.resolve([] as unknown[]);
        const innerJoin = vi.fn(() => ({ innerJoin, where }));
        return { from: fromSpy.mockReturnValue({ innerJoin, where }) } as never;
      }
      const where = () => Promise.resolve([] as unknown[]);
      return { from: () => ({ where }) } as never;
    });

    await generateDueVisits(ORG, now, { withinDays: 30 });

    // The active-membership read uses .from(...).innerJoin(...).innerJoin(...) —
    // the plan + customer joins. A customers.membershipStatus read would not
    // join customerMemberships at all.
    expect(fromSpy).toHaveBeenCalledTimes(1);
  });

  it("skips plans with visitsPerYear=0 (no active membership rows match)", async () => {
    const now = new Date("2026-01-05T00:00:00Z");
    // The query filters visitsPerYear>0 at the DB layer, so a billing-only plan
    // yields zero rows.
    mockSelectSeq([[]]);
    mockClaim([{ id: "x" }]);

    const r = await generateDueVisits(ORG, now, { withinDays: 30 });

    expect(r.scanned).toBe(0);
    expect(r.generated).toBe(0);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("does not generate when the next visit is outside the window", async () => {
    // now = mid-cycle, far from both anniversaries; V1 already past & filtered as
    // generated, V2 still months out.
    const now = new Date("2026-03-01T00:00:00Z");
    mockSelectSeq([[activeMembershipRow()], [{ periodKey: "2026-V1" }]]);
    mockClaim([{ id: "x" }]);

    const r = await generateDueVisits(ORG, now, { withinDays: 30 });

    expect(r.generated).toBe(0);
    expect(db.batch).not.toHaveBeenCalled();
  });
});
