import { describe, it, expect, vi, beforeEach } from "vitest";

const { selectQueue, updateQueue, whereCalls, setCalls, chain, loggerError } =
  vi.hoisted(() => {
    const selectQueue: unknown[][] = [];
    const updateQueue: unknown[][] = [];
    const whereCalls: unknown[][] = [];
    const setCalls: unknown[][] = [];
    const loggerError = vi.fn();
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
          if (prop === "set")
            return (...args: unknown[]) => {
              setCalls.push(args);
              return p;
            };
          return () => p;
        },
        apply: () => p,
      });
      return p;
    };
    return { selectQueue, updateQueue, whereCalls, setCalls, chain, loggerError };
  });

vi.mock("@/lib/db", () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    update: () => chain(updateQueue.shift() ?? []),
  },
}));
vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_t: unknown, orgId: string, ...conditions: unknown[]) => ({
    __tenant: orgId,
    conditions,
  }),
}));
vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => ["eq", ...a],
  and: (...a: unknown[]) => ["and", ...a],
  desc: (c: unknown) => c,
  sql: (_s: TemplateStringsArray, ..._v: unknown[]) => ["sql"],
}));
vi.mock("@/lib/db/schema", () => ({
  dispatchDecisions: {
    id: "dd.id",
    organizationId: "dd.org",
    serviceRequestId: "dd.req",
    chosenTechnicianId: "dd.chosen",
    overriddenTechnicianId: "dd.overTech",
    overriddenByUserId: "dd.overBy",
    overriddenAt: "dd.overAt",
    isShadow: "dd.shadow",
    createdAt: "dd.created",
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: loggerError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { stampDispatchOverride } from "./dispatch-override";

const ORG = "00000000-0000-0000-0000-000000000001";
const REQ = "00000000-0000-0000-0000-0000000000b1";
const HUMAN_TECH = "00000000-0000-0000-0000-0000000000a1";
const ACTOR = "00000000-0000-0000-0000-0000000000f1";

beforeEach(() => {
  selectQueue.length = 0;
  updateQueue.length = 0;
  whereCalls.length = 0;
  setCalls.length = 0;
  loggerError.mockClear();
});

describe("stampDispatchOverride", () => {
  it("stamps the latest decision row when the human pick differs", async () => {
    selectQueue.push([{ id: "dec-1", chosenTechnicianId: "someone-else" }]);
    updateQueue.push([{ id: "dec-1" }]);
    await stampDispatchOverride(ORG, REQ, HUMAN_TECH, ACTOR);
    // One read (latest row) + one write (the stamp).
    expect(whereCalls.length).toBe(2);
    // The read is tenant-scoped and filters on the request.
    expect((whereCalls[0][0] as { __tenant: string }).__tenant).toBe(ORG);
    // The write is tenant-scoped too.
    expect((whereCalls[1][0] as { __tenant: string }).__tenant).toBe(ORG);
    // The UPDATE's set-values carry the three override fields.
    expect(setCalls.length).toBe(1);
    expect(setCalls[0][0]).toEqual(
      expect.objectContaining({
        overriddenTechnicianId: HUMAN_TECH,
        overriddenByUserId: ACTOR,
        overriddenAt: expect.any(Date),
      }),
    );
  });

  it("does NOT stamp when the latest decision row is a shadow row", async () => {
    // The real query filters is_shadow=false, so a request whose only decision is
    // a shadow row returns NO latest row → the stamp must be a no-op. The read's
    // where must carry the isShadow=false filter so the shadow row is excluded.
    selectQueue.push([]); // shadow row filtered out by the query → no latest row
    await stampDispatchOverride(ORG, REQ, HUMAN_TECH, ACTOR);
    expect(whereCalls.length).toBe(1); // only the read ran
    expect(updateQueue.length).toBe(0); // no update attempted
    expect(setCalls.length).toBe(0);
    // The read filters out shadow rows (the isShadow=false condition is present).
    const readConds = (whereCalls[0][0] as { conditions: unknown[] }).conditions;
    expect(JSON.stringify(readConds)).toContain("dd.shadow");
  });

  it("does NOT update when the human pick equals what autopilot chose", async () => {
    // Latest row's chosen tech IS the human's pick → the decision was not
    // overridden, so the helper short-circuits in JS and issues NO update call.
    selectQueue.push([{ id: "dec-1", chosenTechnicianId: HUMAN_TECH }]);
    await stampDispatchOverride(ORG, REQ, HUMAN_TECH, ACTOR);
    expect(whereCalls.length).toBe(1); // only the read ran
    expect(updateQueue.length).toBe(0); // no update chain was consumed
    expect(setCalls.length).toBe(0);
  });

  it("does nothing when there is no decision row", async () => {
    selectQueue.push([]); // no latest row
    await stampDispatchOverride(ORG, REQ, HUMAN_TECH, ACTOR);
    // Only the read ran; no update attempted.
    expect(whereCalls.length).toBe(1);
    expect(updateQueue.length).toBe(0);
  });

  it("swallows a write failure (best-effort, never throws)", async () => {
    selectQueue.push([{ id: "dec-1", chosenTechnicianId: "someone-else" }]);
    // No update queued → chain resolves []; but force the update to throw.
    const throwingChain: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then")
          return () => {
            throw new Error("db down");
          };
        return () => throwingChain;
      },
      apply: () => throwingChain,
    });
    const db = (await import("@/lib/db")).db as unknown as {
      update: () => unknown;
    };
    const spy = vi.spyOn(db, "update").mockReturnValueOnce(throwingChain);
    await expect(
      stampDispatchOverride(ORG, REQ, HUMAN_TECH, ACTOR),
    ).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalled();
    spy.mockRestore();
  });
});
