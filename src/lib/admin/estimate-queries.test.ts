import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createEstimate,
  markEstimateSold,
  approveEstimate,
  getEstimateForApproval,
  expireOverdueEstimates,
  regenerateApprovalToken,
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

describe("expireOverdueEstimates", () => {
  it("flips overdue native open estimates to expired and reports their ids", async () => {
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: "est-1" }, { id: "est-2" }]),
        })),
      })),
    } as never);
    const r = await expireOverdueEstimates(ORG);
    expect(r).toEqual({ expiredIds: ["est-1", "est-2"] });
  });

  it("is a no-op when nothing is eligible (mirrors markEstimateSold's guard shape: nothing returned -> nothing flipped)", async () => {
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
    } as never);
    const r = await expireOverdueEstimates(ORG);
    expect(r).toEqual({ expiredIds: [] });
  });
});

describe("regenerateApprovalToken", () => {
  function hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  it("rejects a non-open estimate (status guard)", async () => {
    mockSelectSeq([[{ id: "est-1", status: "sold", fieldpulseEstimateId: null }]]);
    const r = await regenerateApprovalToken(ORG, "est-1");
    expect(r).toEqual({ ok: false, reason: "already_decided" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns not_found when the estimate is missing", async () => {
    mockSelectSeq([[]]);
    const r = await regenerateApprovalToken(ORG, "est-x");
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses a FieldPulse-synced estimate and never writes", async () => {
    mockSelectSeq([[{ id: "est-fp", status: "open", fieldpulseEstimateId: "fp-123" }]]);
    const r = await regenerateApprovalToken(ORG, "est-fp");
    expect(r).toEqual({ ok: false, reason: "synced_read_only" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("mints a new plaintext token and overwrites the stored hash, invalidating the previous token", async () => {
    // Simulate the estimate's stored hash so we can prove the second call's
    // write no longer matches the first call's plaintext token.
    let storedHash = hash("original-create-time-token");

    mockSelectSeq([
      [{ id: "est-1", status: "open", fieldpulseEstimateId: null }],
      [{ id: "est-1", status: "open", fieldpulseEstimateId: null }],
    ]);
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (payload: { approvalTokenHash: string }) => ({
            where: () => ({
              returning: () => {
                storedHash = payload.approvalTokenHash;
                return Promise.resolve([{ id: "est-1" }]);
              },
            }),
          }),
        }) as never,
    );

    const first = await regenerateApprovalToken(ORG, "est-1");
    expect(first.ok).toBe(true);
    const token1 = (first as { ok: true; approvalToken: string }).approvalToken;
    expect(storedHash).toBe(hash(token1));

    const second = await regenerateApprovalToken(ORG, "est-1");
    expect(second.ok).toBe(true);
    const token2 = (second as { ok: true; approvalToken: string }).approvalToken;

    expect(token1).not.toBe(token2);
    // Only the newest token's hash is stored -> the first token's hash no
    // longer matches, so a lookup by the old token would find nothing.
    expect(storedHash).toBe(hash(token2));
    expect(storedHash).not.toBe(hash(token1));
  });
});

describe("sold_via / sold_by (M3c spec §3)", () => {
  it("markEstimateSold writes sold_via='office' and the admin id", async () => {
    mockSelectSeq([[{ id: "est-1", status: "open", fieldpulseEstimateId: null }], [{ id: "opt-1" }]]);
    const set = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "est-1" }]) })) }));
    vi.mocked(db.update).mockReturnValueOnce({ set } as never);
    expect(await markEstimateSold(ORG, "est-1", "opt-1", "admin-1")).toEqual({ ok: true, estimateId: "est-1" });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "sold", soldVia: "office", soldBy: "admin-1", signatureName: "(admin)" }));
  });

  it("approveEstimate (portal) writes sold_via='portal' and no seller", async () => {
    mockSelectSeq([[{ id: "est-1", organizationId: ORG, status: "open", expiresAt: null }], [{ id: "opt-1" }]]);
    const set = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "est-1" }]) })) }));
    vi.mocked(db.update).mockReturnValueOnce({ set } as never);
    expect(await approveEstimate({ token: "t", optionId: "opt-1", signatureName: "Pat", signatureIp: "1.2.3.4" }))
      .toEqual({ ok: true, estimateId: "est-1" });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "sold", soldVia: "portal", soldBy: null, signatureName: "Pat", signatureIp: "1.2.3.4" }));
  });
});
