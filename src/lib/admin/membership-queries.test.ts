import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  enrollCustomer,
  cancelMembership,
  getActiveMembership,
} from "./membership-queries";
import { db } from "@/lib/db";
import { MockPaymentProvider } from "@/lib/payments/provider";

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
const CUST = "cust-1";
const PLAN = "plan-1";

/**
 * Sequence db.select results across calls. Each `.from()` supports `.innerJoin()`
 * (the active-membership read joins the plan) and each `.where()` is `.limit()`-able.
 */
function mockSelectSeq(results: unknown[][]) {
  let i = 0;
  const where = () => {
    const r = results[i++] ?? [];
    const p = Promise.resolve(r);
    return Object.assign(p, { limit: () => Promise.resolve(r) });
  };
  const from = () => ({ where, innerJoin: () => ({ where }) });
  vi.mocked(db.select).mockImplementation(() => ({ from }) as never);
}

/** Row shape returned by getActiveMembership's joined select. */
function activeRow() {
  return {
    id: "mem-1",
    planId: PLAN,
    status: "active",
    startedAt: new Date("2026-01-01"),
    currentPeriodEnd: new Date("2026-02-01"),
    planName: "Comfort Club",
    planDescription: "Annual tune-ups",
    planPriceCents: 1999,
    planBillingPeriod: "monthly",
    planActive: true,
  };
}

/** Row shape returned by getMembershipPlanById's select. */
function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PLAN,
    name: "Comfort Club",
    description: null,
    priceCents: 1999,
    billingPeriod: "monthly",
    active: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue(undefined),
  } as never);
});

describe("enrollCustomer", () => {
  const provider = new MockPaymentProvider();

  it("writes the membership AND derives customers.membershipStatus in ONE batch", async () => {
    mockSelectSeq([
      [planRow()], // getMembershipPlanById -> plan exists & active
      [], // getActiveMembership -> no existing active membership
    ]);
    const r = await enrollCustomer(ORG, CUST, PLAN, {}, provider);
    expect(r.ok).toBe(true);
    // Membership insert + customers.membershipStatus update batched together.
    expect(db.batch).toHaveBeenCalledTimes(1);
    const batched = vi.mocked(db.batch).mock.calls[0]![0];
    expect(batched).toHaveLength(2);
  });

  it("rejects a double-enroll when an active membership already exists", async () => {
    mockSelectSeq([
      [planRow()], // plan exists
      [activeRow()], // already enrolled
    ]);
    const r = await enrollCustomer(ORG, CUST, PLAN, {}, provider);
    expect(r).toEqual({ ok: false, reason: "already_enrolled" });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("rejects when the plan is missing or belongs to another org", async () => {
    mockSelectSeq([[]]); // getMembershipPlanById -> none
    const r = await enrollCustomer(ORG, CUST, PLAN, {}, provider);
    expect(r).toEqual({ ok: false, reason: "plan_not_found" });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("rejects when the plan is inactive (soft-deleted)", async () => {
    mockSelectSeq([[planRow({ active: false })]]);
    const r = await enrollCustomer(ORG, CUST, PLAN, {}, provider);
    expect(r).toEqual({ ok: false, reason: "plan_not_found" });
  });

  it("takes a mock charge keyed by membership id when chargeFirstPeriod", async () => {
    mockSelectSeq([[planRow()], []]);
    const chargeSpy = vi
      .fn()
      .mockResolvedValue({ providerPaymentId: "mock_pay_x", status: "succeeded" });
    const spyProvider = { name: "mock", createCharge: chargeSpy } as never;
    const r = await enrollCustomer(
      ORG,
      CUST,
      PLAN,
      { chargeFirstPeriod: true },
      spyProvider,
    );
    expect(r.ok).toBe(true);
    expect(chargeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 1999 }),
    );
    // The idempotency key is the membership id (stable retry).
    if (r.ok) {
      expect(chargeSpy.mock.calls[0]![0].idempotencyKey).toBe(r.membershipId);
    }
  });

  it("gates enrollment on a successful charge — no batch when the charge fails", async () => {
    mockSelectSeq([[planRow()], []]);
    const failing = {
      name: "mock",
      createCharge: vi
        .fn()
        .mockResolvedValue({ providerPaymentId: "", status: "failed" }),
    } as never;
    const r = await enrollCustomer(
      ORG,
      CUST,
      PLAN,
      { chargeFirstPeriod: true },
      failing,
    );
    expect(r).toEqual({ ok: false, reason: "charge_failed" });
    expect(db.batch).not.toHaveBeenCalled();
  });
});

describe("cancelMembership", () => {
  it("cancels + derives customers.membershipStatus in one batch", async () => {
    mockSelectSeq([[activeRow()]]); // getActiveMembership -> active exists
    const r = await cancelMembership(ORG, CUST);
    expect(r).toEqual({ ok: true, cancelled: true });
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.batch).mock.calls[0]![0]).toHaveLength(2);
  });

  it("is idempotent — a second cancel with no active membership no-ops", async () => {
    mockSelectSeq([[]]); // no active membership
    const r = await cancelMembership(ORG, CUST);
    expect(r).toEqual({ ok: false, reason: "not_a_member" });
    expect(db.batch).not.toHaveBeenCalled();
  });
});

describe("getActiveMembership", () => {
  it("returns the active membership + plan when one exists", async () => {
    mockSelectSeq([[activeRow()]]);
    const m = await getActiveMembership(ORG, CUST);
    expect(m).not.toBeNull();
    expect(m?.id).toBe("mem-1");
    expect(m?.plan.priceCents).toBe(1999);
  });

  it("returns null when the customer is not a member", async () => {
    mockSelectSeq([[]]);
    const m = await getActiveMembership(ORG, CUST);
    expect(m).toBeNull();
  });
});
