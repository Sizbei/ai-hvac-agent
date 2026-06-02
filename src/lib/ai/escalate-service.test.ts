import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateReturning, mockInsert } = vi.hoisted(() => ({
  updateReturning: { value: [] as unknown[] },
  mockInsert: vi.fn(),
}));

function chain(resolved: unknown): unknown {
  const p: unknown = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === "then") {
        return (r: (v: unknown) => void) => r(resolved);
      }
      return () => p;
    },
    apply: () => p,
  });
  return p;
}

vi.mock("@/lib/db", () => ({
  db: {
    update: () => chain(updateReturning.value),
    insert: () => {
      mockInsert();
      return { values: () => chain([]) };
    },
  },
}));
vi.mock("@/lib/db/schema", () => ({
  customerSessions: { id: "cs.id", organizationId: "cs.org", status: "cs.status" },
  auditLog: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => a,
  and: (...a: unknown[]) => a,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { escalateSession } from "./escalate-service";

const BASE = {
  organizationId: "org-1",
  sessionId: "sess-1",
  ipAddress: "1.2.3.4",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  updateReturning.value = [];
});

describe("escalateSession — concurrency guard", () => {
  it("escalates and writes one audit row when the status-guarded UPDATE matches", async () => {
    updateReturning.value = [{ id: "sess-1" }];
    const r = await escalateSession({ ...BASE, currentStatus: "chatting" });
    expect(r.ok).toBe(true);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("does NOT write a duplicate audit row when the UPDATE matched zero rows (already moved)", async () => {
    updateReturning.value = []; // status guard matched nothing
    const r = await escalateSession({ ...BASE, currentStatus: "chatting" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("already_transitioned");
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("treats an already-escalated session as idempotent success (no new audit)", async () => {
    updateReturning.value = []; // no-op update (already escalated)
    const r = await escalateSession({ ...BASE, currentStatus: "escalated" });
    expect(r.ok).toBe(true);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects an invalid state transition before touching the DB", async () => {
    const r = await escalateSession({ ...BASE, currentStatus: "submitted" });
    expect(r.ok).toBe(false);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
