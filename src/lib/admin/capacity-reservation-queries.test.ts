import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Focused db mock ────────────────────────────────────────────────
// select(...).from(...).where(...) resolves to `selectRows`; insert(...).values
// (...).onConflictDoNothing(...).returning(...) resolves to the next queued
// `insertReturns` entry ([] = conflict/lost CAS, [{id}] = won). We record every
// ordinal an insert was attempted at so the fall-through can be asserted.
const { state } = vi.hoisted(() => ({
  state: {
    selectRows: [] as { slotOrdinal: number }[],
    insertReturns: [] as unknown[][],
    insertedOrdinals: [] as number[],
    selectError: null as Error | null,
  },
}));

vi.mock("@/lib/db", () => {
  const selectChain = {
    from: () => selectChain,
    where: () =>
      state.selectError
        ? Promise.reject(state.selectError)
        : Promise.resolve(state.selectRows),
  };
  return {
    db: {
      select: () => selectChain,
      insert: () => ({
        values: (v: { slotOrdinal: number }) => {
          state.insertedOrdinals.push(v.slotOrdinal);
          return {
            onConflictDoNothing: () => ({
              returning: () =>
                Promise.resolve(state.insertReturns.shift() ?? []),
            }),
          };
        },
      }),
    },
  };
});

import {
  freeOrdinals,
  reserveCapacitySlot,
} from "./capacity-reservation-queries";

beforeEach(() => {
  state.selectRows = [];
  state.insertReturns = [];
  state.insertedOrdinals = [];
  state.selectError = null;
});

describe("freeOrdinals — pure ordinal selection", () => {
  it("returns every ordinal in [0, ceiling) when none are taken", () => {
    expect(freeOrdinals(new Set(), 3)).toEqual([0, 1, 2]);
  });

  it("skips taken ordinals, ascending", () => {
    expect(freeOrdinals(new Set([0, 2]), 4)).toEqual([1, 3]);
  });

  it("returns [] when the band is full (all ordinals taken)", () => {
    expect(freeOrdinals(new Set([0, 1, 2]), 3)).toEqual([]);
  });

  it("returns [] for a zero (or negative) ceiling", () => {
    expect(freeOrdinals(new Set(), 0)).toEqual([]);
    expect(freeOrdinals(new Set(), -1)).toEqual([]);
  });
});

const base = {
  organizationId: "org-1",
  day: "2026-07-07",
  window: "morning",
  serviceRequestId: "req-1",
};

describe("reserveCapacitySlot — CAS claim", () => {
  it("returns null without touching the db when ceiling <= 0", async () => {
    const result = await reserveCapacitySlot({ ...base, ceiling: 0 });
    expect(result).toBeNull();
    expect(state.insertedOrdinals).toEqual([]);
  });

  it("claims the lowest free ordinal (0) on the first try", async () => {
    state.selectRows = [];
    state.insertReturns = [[{ id: "res-0" }]];
    const result = await reserveCapacitySlot({ ...base, ceiling: 2 });
    expect(result).toEqual({ id: "res-0", ordinal: 0 });
    expect(state.insertedOrdinals).toEqual([0]);
  });

  it("falls through to the next ordinal when a concurrent claim took ordinal 0", async () => {
    state.selectRows = []; // our read saw nothing taken…
    // …but the insert at ordinal 0 loses the CAS (unique conflict → []), and the
    // retry at ordinal 1 wins.
    state.insertReturns = [[], [{ id: "res-1" }]];
    const result = await reserveCapacitySlot({ ...base, ceiling: 2 });
    expect(result).toEqual({ id: "res-1", ordinal: 1 });
    expect(state.insertedOrdinals).toEqual([0, 1]);
  });

  it("returns null when every ordinal in the ceiling loses the CAS (band full)", async () => {
    state.selectRows = [];
    state.insertReturns = [[], []]; // both ordinals conflicted
    const result = await reserveCapacitySlot({ ...base, ceiling: 2 });
    expect(result).toBeNull();
    expect(state.insertedOrdinals).toEqual([0, 1]);
  });

  it("skips ordinals already taken at read time and claims the first free one", async () => {
    state.selectRows = [{ slotOrdinal: 0 }]; // ordinal 0 already reserved
    state.insertReturns = [[{ id: "res-1" }]];
    const result = await reserveCapacitySlot({ ...base, ceiling: 2 });
    expect(result).toEqual({ id: "res-1", ordinal: 1 });
    // Only ordinal 1 is attempted — 0 was known-taken.
    expect(state.insertedOrdinals).toEqual([1]);
  });

  it("returns null (never throws) when the db read blows up", async () => {
    state.selectError = new Error("db down");
    const result = await reserveCapacitySlot({ ...base, ceiling: 2 });
    expect(result).toBeNull();
    expect(state.insertedOrdinals).toEqual([]);
  });
});
