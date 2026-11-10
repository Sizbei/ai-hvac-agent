import { describe, it, expect, vi, beforeEach } from "vitest";

const { selectQueue, whereCalls, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const whereCalls: unknown[][] = [];
  const chain = (resolved: unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then")
          return (resolve: (v: unknown) => void) => resolve(resolved);
        if (prop === "where")
          return (...args: unknown[]) => {
            whereCalls.push(args);
            return p;
          };
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };
  return { selectQueue, whereCalls, chain };
});

vi.mock("@/lib/db", () => ({
  db: { select: () => chain(selectQueue.shift() ?? []) },
}));
vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_t: unknown, orgId: string, ...conditions: unknown[]) => ({
    __tenant: orgId,
    conditions,
  }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ["and", ...a],
  asc: (c: unknown) => c,
  eq: (...a: unknown[]) => ["eq", ...a],
  isNull: (c: unknown) => ["isNull", c],
  notInArray: (...a: unknown[]) => ["notInArray", ...a],
  like: (...a: unknown[]) => ["like", ...a],
}));
vi.mock("@/lib/db/schema", () => ({
  serviceRequests: {
    id: "sr.id",
    organizationId: "sr.org",
    referenceNumber: "sr.ref",
    issueType: "sr.issue",
    urgency: "sr.urgency",
    status: "sr.status",
    assignedTo: "sr.assignedTo",
    autoDispatchOutcome: "sr.outcome",
    createdAt: "sr.created",
  },
}));

import { getDispatchExceptions } from "./dispatch-exceptions-queries";
import { VISIBLE_ONLY } from "./visibility";

const ORG = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  selectQueue.length = 0;
  whereCalls.length = 0;
});

describe("getDispatchExceptions", () => {
  it("maps queued+unassigned rows, oldest first, tenant-scoped", async () => {
    selectQueue.push([
      {
        id: "r1",
        referenceNumber: "REF-1",
        issueType: "no_cool",
        urgency: "standard",
        autoDispatchOutcome: "queued_ambiguous",
        createdAt: new Date("2026-07-20T10:00:00Z"),
      },
    ]);
    const rows = await getDispatchExceptions(ORG, VISIBLE_ONLY);
    expect(rows).toEqual([
      {
        id: "r1",
        referenceNumber: "REF-1",
        issueType: "no_cool",
        urgency: "standard",
        autoDispatchOutcome: "queued_ambiguous",
        createdAt: "2026-07-20T10:00:00.000Z",
      },
    ]);
    const conds = (whereCalls[0][0] as { conditions: unknown[] }).conditions;
    expect((whereCalls[0][0] as { __tenant: string }).__tenant).toBe(ORG);
    // Unassigned + like queued_% + status not cancelled/completed.
    expect(conds).toContainEqual(["isNull", "sr.assignedTo"]);
    expect(conds).toContainEqual(["like", "sr.outcome", "queued_%"]);
    expect(
      conds.some((c) => Array.isArray(c) && c[0] === "notInArray"),
    ).toBe(true);
  });

  it("returns [] when nothing is queued", async () => {
    selectQueue.push([]);
    expect(await getDispatchExceptions(ORG, VISIBLE_ONLY)).toEqual([]);
  });
});
