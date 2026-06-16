import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  markEstimateSold,
  getEstimateForApproval,
} from "./estimate-queries";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
      })),
    })),
  },
}));

const ORG = "org-1";

/** Sequence db.select results; each where() is awaitable AND .limit()-able. */
function mockSelectSeq(results: unknown[][]): void {
  let i = 0;
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: () => ({
          where: () => {
            const r = results[i++] ?? [];
            const p = Promise.resolve(r);
            return Object.assign(p, {
              limit: () => Promise.resolve(r),
              orderBy: () => Promise.resolve(r),
            });
          },
        }),
      }) as never,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("markEstimateSold", () => {
  it("rejects a non-open estimate (status guard)", async () => {
    mockSelectSeq([[{ id: "est-1", status: "sold" }]]);
    const r = await markEstimateSold(ORG, "est-1", "opt-1");
    expect(r).toEqual({ ok: false, reason: "already_decided" });
  });

  it("returns not_found when the estimate is missing", async () => {
    mockSelectSeq([[]]);
    const r = await markEstimateSold(ORG, "est-x", "opt-1");
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects an option that does not belong to the estimate", async () => {
    mockSelectSeq([
      [{ id: "est-1", status: "open" }], // estimate is open
      [], // option lookup finds nothing
    ]);
    const r = await markEstimateSold(ORG, "est-1", "opt-bad");
    expect(r).toEqual({ ok: false, reason: "invalid_option" });
  });

  it("marks an open estimate sold for a valid option", async () => {
    mockSelectSeq([
      [{ id: "est-1", status: "open" }],
      [{ id: "opt-1" }],
    ]);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: "est-1" }]),
        })),
      })),
    } as never);
    const r = await markEstimateSold(ORG, "est-1", "opt-1");
    expect(r).toEqual({ ok: true, estimateId: "est-1" });
  });
});

describe("getEstimateForApproval", () => {
  it("returns null for an unknown token", async () => {
    mockSelectSeq([[]]);
    const r = await getEstimateForApproval("nope");
    expect(r).toBeNull();
  });
});
