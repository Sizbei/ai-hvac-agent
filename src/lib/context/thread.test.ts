import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted, mutable mocks ---
// A single mutable `db` object so each test can swap db.insert / db.select to
// exercise the best-effort (appendEvent) and fail-open (getThread) branches.

const { db, mockLoggerError } = vi.hoisted(() => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
  } as { insert: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> },
  mockLoggerError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db }));

vi.mock("@/lib/logger", () => ({
  logger: { error: mockLoggerError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db/schema", () => ({
  customerThreads: {
    id: "ct.id",
    organizationId: "ct.organizationId",
    customerId: "ct.customerId",
    lastChannel: "ct.lastChannel",
    lastEventAt: "ct.lastEventAt",
    openEstimateCount: "ct.openEstimateCount",
    updatedAt: "ct.updatedAt",
  },
  customerEvents: {
    id: "ce.id",
    organizationId: "ce.organizationId",
    customerId: "ce.customerId",
    threadId: "ce.threadId",
    kind: "ce.kind",
    refId: "ce.refId",
    jobType: "ce.jobType",
    window: "ce.window",
    labelKey: "ce.labelKey",
    at: "ce.at",
  },
}));

vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_table: unknown, _org: string, ...conds: unknown[]) => conds,
}));

import { appendEvent, EMPTY_THREAD, getThread, resolveThread } from "./thread";

// A thenable chainable builder: every method returns `this`, and awaiting it
// resolves to `resolved`. Used to model drizzle's fluent query builder.
function chain(resolved: unknown) {
  const builder: Record<string, unknown> = {};
  const methods = [
    "values",
    "onConflictDoUpdate",
    "returning",
    "from",
    "where",
    "orderBy",
    "limit",
  ];
  for (const m of methods) builder[m] = () => builder;
  builder.then = (resolve: (v: unknown) => void) => resolve(resolved);
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("appendEvent (best-effort)", () => {
  it("never throws when the event insert chain throws", async () => {
    let call = 0;
    // First insert = thread upsert (succeeds → [{id:'t1'}]).
    // Second insert = event insert (throws).
    db.insert.mockImplementation(() => {
      call += 1;
      if (call === 1) return chain([{ id: "t1" }]);
      throw new Error("event insert boom");
    });

    await expect(
      appendEvent("org1", "cust1", { kind: "booking", labelKey: "booked" }),
    ).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    // Lock in the structured, PII-free log payload (ids + kind only).
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1", customerId: "cust1", kind: "booking" }),
      expect.any(String),
    );
  });
});

describe("resolveThread", () => {
  it("returns {threadId, customerId} when a row exists", async () => {
    db.select.mockReturnValue(chain([{ id: "thread1" }]));

    const result = await resolveThread("org1", "cust1");

    expect(result).toEqual({ threadId: "thread1", customerId: "cust1" });
  });

  it("returns null when no row exists", async () => {
    db.select.mockReturnValue(chain([]));

    const result = await resolveThread("org1", "cust1");

    expect(result).toBeNull();
  });
});

describe("getThread", () => {
  it("returns EMPTY_THREAD on a DB error and never throws", async () => {
    db.select.mockImplementation(() => {
      throw new Error("select boom");
    });

    const result = await getThread("org1", "cust1");

    expect(result).toBe(EMPTY_THREAD);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it("fails open when the EVENTS query (second select) throws, not just the first", async () => {
    let call = 0;
    db.select.mockImplementation(() => {
      call += 1;
      if (call === 1) return chain([{ lastChannel: "web", openEstimateCount: 0 }]);
      throw new Error("events select boom");
    });

    const result = await getThread("org1", "cust1");

    expect(result).toBe(EMPTY_THREAD);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it("returns {exists:true, ...} with rendered PII-free event lines", async () => {
    const eventAt = new Date("2026-06-01T12:00:00Z");
    let call = 0;
    db.select.mockImplementation(() => {
      call += 1;
      // First select = thread row; second select = events rows.
      if (call === 1) {
        return chain([{ lastChannel: "voice", openEstimateCount: 2 }]);
      }
      return chain([
        {
          at: eventAt,
          kind: "booking",
          labelKey: "booked",
          jobType: "AC repair",
          window: "tomorrow AM",
          refId: "secret-ref-123",
        },
      ]);
    });

    const result = await getThread("org1", "cust1");

    expect(result.exists).toBe(true);
    expect(result.lastChannel).toBe("voice");
    expect(result.openEstimateCount).toBe(2);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      at: eventAt,
      kind: "booking",
      label: "Booked AC repair (tomorrow AM)",
    });
    // PII-free: the refId must never leak into the rendered label.
    expect(result.events[0].label).not.toContain("secret-ref-123");
  });
});
