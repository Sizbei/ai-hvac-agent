import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: { insert: vi.fn(), select: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { db } from "@/lib/db";
import {
  parseBillingEvent,
  applyBillingEvent,
  type BillingWebhookEvent,
} from "./webhook-sync";

const ORG = "00000000-0000-0000-0000-000000000001";

/** Captured values passed to the FIRST db.insert (the ledger row). */
let ledgerInsertValues: Record<string, unknown> | undefined;

/** First db.insert call = ledger (with returning), subsequent = audit (await). */
function mockInsertSequence(ledgerRows: unknown[]) {
  let call = 0;
  ledgerInsertValues = undefined;
  vi.mocked(db.insert).mockImplementation(
    () =>
      ({
        values: (vals: unknown) => {
          call += 1;
          if (call === 1) {
            ledgerInsertValues = vals as Record<string, unknown>;
            return {
              onConflictDoNothing: () => ({
                returning: () => Promise.resolve(ledgerRows),
              }),
            };
          }
          // audit insert — values() returns a thenable with .catch (awaited).
          return Promise.resolve(undefined);
        },
      }) as never,
  );
}

/** Spy for the compensating ledger delete (releaseEvent). */
let deleteSpy: ReturnType<typeof vi.fn<() => void>>;
function mockDelete() {
  deleteSpy = vi.fn<() => void>();
  (db.delete as unknown as ReturnType<typeof vi.fn<() => unknown>>).mockReturnValue({
    where: () => {
      deleteSpy();
      return { catch: () => Promise.resolve(undefined) };
    },
  });
}

function mockOrgSelect(rows: unknown[]) {
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve(rows) }),
        }),
      }) as never,
  );
}

let updateSpy: ReturnType<typeof vi.fn<(vals: unknown) => void>>;
function mockUpdate() {
  updateSpy = vi.fn<(vals: unknown) => void>();
  vi.mocked(db.update).mockReturnValue({
    set: (vals: unknown) => ({
      where: () => {
        updateSpy(vals);
        return Promise.resolve(undefined);
      },
    }),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate();
  mockDelete();
});

describe("parseBillingEvent", () => {
  it("accepts a well-formed event", () => {
    const e = parseBillingEvent({
      id: "evt_1",
      type: "subscription.created",
      orgId: ORG,
      planId: "pro",
    });
    expect(e).not.toBeNull();
    expect(e?.type).toBe("subscription.created");
  });

  it("rejects an unknown type / missing ids", () => {
    expect(parseBillingEvent({ id: "x", type: "nope", orgId: ORG })).toBeNull();
    expect(parseBillingEvent({ type: "payment_failed", orgId: ORG })).toBeNull();
    expect(parseBillingEvent(null)).toBeNull();
  });
});

describe("applyBillingEvent", () => {
  const created: BillingWebhookEvent = {
    id: "evt_create",
    type: "subscription.created",
    orgId: ORG,
    planId: "pro",
    currentPeriodEnd: "2026-07-15T00:00:00.000Z",
  };

  it("dedupes a redelivery (ledger conflict → duplicate, no update)", async () => {
    mockInsertSequence([]); // zero rows from returning = already seen
    const res = await applyBillingEvent(created);
    expect(res.outcome).toBe("duplicate");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("maps subscription.created → active + plan set + period end", async () => {
    mockInsertSequence([{ id: "led_1" }]);
    mockOrgSelect([{ id: ORG }]);
    const res = await applyBillingEvent(created);
    expect(res.outcome).toBe("applied");
    expect(updateSpy).toHaveBeenCalledOnce();
    const vals = updateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(vals.status).toBe("active");
    expect(vals.plan).toBe("pro");
    expect(vals.currentPeriodEnd).toBeInstanceOf(Date);
  });

  it("maps payment_failed → past_due, leaving plan untouched", async () => {
    mockInsertSequence([{ id: "led_2" }]);
    mockOrgSelect([{ id: ORG }]);
    const res = await applyBillingEvent({
      id: "evt_pf",
      type: "payment_failed",
      orgId: ORG,
    });
    expect(res.outcome).toBe("applied");
    const vals = updateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(vals.status).toBe("past_due");
    expect(vals.plan).toBeUndefined();
  });

  it("maps subscription.deleted → suspended + plan cleared", async () => {
    mockInsertSequence([{ id: "led_3" }]);
    mockOrgSelect([{ id: ORG }]);
    const res = await applyBillingEvent({
      id: "evt_del",
      type: "subscription.deleted",
      orgId: ORG,
    });
    expect(res.outcome).toBe("applied");
    const vals = updateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(vals.status).toBe("suspended");
    expect(vals.plan).toBeNull();
    expect(vals.currentPeriodEnd).toBeNull();
  });

  it("always records the ledger row with a NULL organizationId (FK-safe)", async () => {
    mockInsertSequence([{ id: "led_null" }]);
    mockOrgSelect([{ id: ORG }]);
    await applyBillingEvent(created);
    // organizationId is provider-supplied and may not exist; the ledger stores
    // null so an unknown org never triggers an FK violation.
    expect(ledgerInsertValues?.organizationId).toBeNull();
    expect(ledgerInsertValues?.eventId).toBe("evt_create");
  });

  it("no-ops (unknown_org) for a well-formed but nonexistent org — no throw, no update", async () => {
    mockInsertSequence([{ id: "led_4" }]);
    mockOrgSelect([]); // org missing
    // A well-formed UUID that isn't in organizations. The ledger insert used a
    // null org (above), so this does NOT throw an FK violation → route would 200.
    const res = await applyBillingEvent({
      id: "evt_unknown_org",
      type: "subscription.created",
      orgId: "11111111-1111-1111-1111-111111111111",
      planId: "pro",
    });
    expect(res.outcome).toBe("unknown_org");
    expect(updateSpy).not.toHaveBeenCalled();
    expect(ledgerInsertValues?.organizationId).toBeNull();
    // Not released: an unknown org is a terminal no-op, kept as seen (deduped).
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("idempotency dedupe still works (event_id conflict → duplicate)", async () => {
    mockInsertSequence([]); // zero returning rows = conflict on event_id
    mockOrgSelect([]);
    const res = await applyBillingEvent({
      id: "evt_dupe",
      type: "subscription.created",
      orgId: "11111111-1111-1111-1111-111111111111",
      planId: "pro",
    });
    expect(res.outcome).toBe("duplicate");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rejects an invalid plan id (invalid_plan, no update, RELEASED for retry)", async () => {
    mockInsertSequence([{ id: "led_5" }]);
    mockOrgSelect([{ id: ORG }]);
    const res = await applyBillingEvent({
      id: "evt_bad",
      type: "subscription.updated",
      orgId: ORG,
      planId: "totally-fake",
    });
    expect(res.outcome).toBe("invalid_plan");
    expect(updateSpy).not.toHaveBeenCalled();
    // Released so a redelivery after a plan-catalog deploy can reprocess.
    expect(deleteSpy).toHaveBeenCalledOnce();
  });
});
