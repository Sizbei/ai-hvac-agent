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
  desc: (c: unknown) => c,
  inArray: (...a: unknown[]) => ["inArray", ...a],
}));
vi.mock("@/lib/db/schema", () => ({
  dispatchDecisions: {
    id: "dd.id",
    organizationId: "dd.org",
    serviceRequestId: "dd.req",
    outcome: "dd.outcome",
    isShadow: "dd.shadow",
    chosenTechnicianId: "dd.chosen",
    topScore: "dd.top",
    confidenceGap: "dd.gap",
    candidates: "dd.cands",
    createdAt: "dd.created",
    overriddenTechnicianId: "dd.overTech",
    overriddenByUserId: "dd.overBy",
    overriddenAt: "dd.overAt",
  },
  users: { id: "u.id", organizationId: "u.org", name: "u.name" },
}));

import { getDispatchDecisionForRequest } from "./dispatch-decision-queries";

const ORG = "00000000-0000-0000-0000-000000000001";
const REQ = "00000000-0000-0000-0000-0000000000b1";
const T1 = "00000000-0000-0000-0000-0000000000a1";
const T2 = "00000000-0000-0000-0000-0000000000a2";
const T3 = "00000000-0000-0000-0000-0000000000a3";

beforeEach(() => {
  selectQueue.length = 0;
  whereCalls.length = 0;
});

describe("getDispatchDecisionForRequest", () => {
  it("returns the latest row with candidate names + STORED skillMatched (absent → null)", async () => {
    selectQueue.push([
      {
        outcome: "committed",
        isShadow: false,
        chosenTechnicianId: T1,
        topScore: 0.82,
        confidenceGap: 0.12,
        createdAt: new Date("2026-07-20T10:00:00Z"),
        overriddenTechnicianId: null,
        overriddenByUserId: null,
        overriddenAt: null,
        candidates: [
          // Stored true.
          { technicianId: T1, score: 0.82, reasons: ["5 prior jobs"], travelKm: 3.2, travelMinutes: 8, skillMatched: true },
          // Stored false.
          { technicianId: T2, score: 0.7, reasons: ["no prior experience"], travelKm: null, travelMinutes: null, skillMatched: false },
          // Legacy row: skillMatched key ABSENT → surfaces as null (unknown).
          { technicianId: T3, score: 0.6, reasons: ["2 prior jobs"], travelKm: null, travelMinutes: null },
        ],
      },
    ]);
    selectQueue.push([
      { id: T1, name: "Alice" },
      { id: T2, name: "Bob" },
      { id: T3, name: "Carol" },
    ]);
    const view = await getDispatchDecisionForRequest(ORG, REQ);
    expect(view).not.toBeNull();
    expect(view!.outcome).toBe("committed");
    expect(view!.isShadow).toBe(false);
    expect(view!.chosenTechnicianId).toBe(T1);
    expect(view!.createdAt).toBe("2026-07-20T10:00:00.000Z");
    expect(view!.candidates).toHaveLength(3);
    expect(view!.candidates[0]).toMatchObject({
      technicianId: T1,
      name: "Alice",
      score: 0.82,
      travelKm: 3.2,
      travelMinutes: 8,
      skillMatched: true, // read from the stored field
    });
    expect(view!.candidates[1]).toMatchObject({ name: "Bob", skillMatched: false });
    // Legacy candidate: stored field absent → null (unknown), never guessed.
    expect(view!.candidates[2]).toMatchObject({ name: "Carol", skillMatched: null });
    expect((whereCalls[0][0] as { __tenant: string }).__tenant).toBe(ORG);
  });

  it("returns null when there is no decision row", async () => {
    selectQueue.push([]);
    const view = await getDispatchDecisionForRequest(ORG, REQ);
    expect(view).toBeNull();
  });
});
