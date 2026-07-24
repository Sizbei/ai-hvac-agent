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
  eq: (...a: unknown[]) => ["eq", ...a],
  gte: (...a: unknown[]) => ["gte", ...a],
  isNotNull: (c: unknown) => ["isNotNull", c],
  sql: Object.assign(
    (_s: TemplateStringsArray, ..._v: unknown[]) => ["sql"],
    { raw: (s: string) => ["sqlraw", s] },
  ),
}));
vi.mock("@/lib/db/schema", () => ({
  dispatchDecisions: {
    organizationId: "dd.org",
    outcome: "dd.outcome",
    isShadow: "dd.shadow",
    overriddenAt: "dd.overAt",
    createdAt: "dd.created",
  },
}));

import { getDispatchOutcomeRollup } from "./dispatch-rollup";

const ORG = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  selectQueue.length = 0;
  whereCalls.length = 0;
});

describe("getDispatchOutcomeRollup", () => {
  it("splits real vs shadow, counts overrides, computes commit rate over both", async () => {
    // One grouped query returns (outcome, is_shadow, n) rows + a separate overrides count.
    selectQueue.push([
      { outcome: "committed", isShadow: false, n: 8 },
      { outcome: "queued_ambiguous", isShadow: false, n: 2 },
      { outcome: "committed", isShadow: true, n: 5 },
      { outcome: "queued_no_fit", isShadow: true, n: 5 },
    ]);
    selectQueue.push([{ n: 3 }]); // overrides count
    const r = await getDispatchOutcomeRollup(ORG, 7);
    expect(r.days).toBe(7);
    expect(r.real.committed).toBe(8);
    expect(r.real.queuedAmbiguous).toBe(2);
    expect(r.real.total).toBe(10);
    expect(r.shadow.committed).toBe(5);
    expect(r.shadow.queuedNoFit).toBe(5);
    expect(r.shadow.total).toBe(10);
    expect(r.overrides).toBe(3);
    // commit rate = (8 + 5) committed / 20 total over real+shadow = 0.65
    expect(r.commitRate).toBeCloseTo(0.65, 5);
    expect((whereCalls[0][0] as { __tenant: string }).__tenant).toBe(ORG);
  });

  it("returns commitRate null when there are no decisions", async () => {
    selectQueue.push([]); // no grouped rows
    selectQueue.push([{ n: 0 }]); // overrides
    const r = await getDispatchOutcomeRollup(ORG, 7);
    expect(r.real.total).toBe(0);
    expect(r.shadow.total).toBe(0);
    expect(r.commitRate).toBeNull();
  });
});
