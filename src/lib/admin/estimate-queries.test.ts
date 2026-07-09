import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createEstimate,
  markEstimateSold,
  getEstimateForApproval,
} from "./estimate-queries";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(() => ({ values: vi.fn((rows: unknown) => rows) })),
    batch: vi.fn().mockResolvedValue([]),
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

describe("createEstimate", () => {
  it("snapshots costCents onto each line item row", async () => {
    const { estimateId, approvalToken } = await createEstimate(ORG, {
      taxBps: 0,
      options: [
        {
          name: "Good",
          lineItems: [
            {
              pricebookItemId: "pb-1",
              name: "AC tune-up",
              quantity: 2,
              unitPriceCents: 15000,
              costCents: 6000,
            },
            // manual line: no cost provided -> stored as 0
            { name: "Misc", quantity: 1, unitPriceCents: 2500 },
          ],
        },
      ],
    });
    expect(estimateId).toBeTruthy();
    expect(approvalToken).toBeTruthy();

    // The 3rd statement batched is the line-items insert; our values() mock
    // returns the row array verbatim so we can assert what was stored.
    expect(db.batch).toHaveBeenCalledTimes(1);
    const batchArgs = vi.mocked(db.batch).mock.calls[0]![0] as unknown as unknown[];
    const lineRows = batchArgs[2] as Array<{
      name: string;
      costCents: number;
      unitPriceCents: number;
      lineTotalCents: number;
    }>;
    expect(lineRows).toHaveLength(2);
    const tuneUp = lineRows.find((r) => r.name === "AC tune-up")!;
    expect(tuneUp.costCents).toBe(6000);
    expect(tuneUp.lineTotalCents).toBe(30000); // qty 2 × 15000
    const misc = lineRows.find((r) => r.name === "Misc")!;
    expect(misc.costCents).toBe(0); // manual line defaults cost to 0
  });
});

describe("markEstimateSold", () => {
  it("rejects a non-open estimate (status guard)", async () => {
    mockSelectSeq([[{ id: "est-1", status: "sold", fieldpulseEstimateId: null }]]);
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
      [{ id: "est-1", status: "open", fieldpulseEstimateId: null }], // native, open
      [], // option lookup finds nothing
    ]);
    const r = await markEstimateSold(ORG, "est-1", "opt-bad");
    expect(r).toEqual({ ok: false, reason: "invalid_option" });
  });

  it("marks an open estimate sold for a valid option", async () => {
    mockSelectSeq([
      [{ id: "est-1", status: "open", fieldpulseEstimateId: null }],
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

  it("refuses a FieldPulse-synced estimate and never writes", async () => {
    mockSelectSeq([[{ id: "est-fp", status: "open", fieldpulseEstimateId: "fp-123" }]]);
    const r = await markEstimateSold(ORG, "est-fp", "opt-1");
    expect(r).toEqual({ ok: false, reason: "synced_read_only" });
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("getEstimateForApproval", () => {
  it("returns null for an unknown token", async () => {
    mockSelectSeq([[]]);
    const r = await getEstimateForApproval("nope");
    expect(r).toBeNull();
  });
});
