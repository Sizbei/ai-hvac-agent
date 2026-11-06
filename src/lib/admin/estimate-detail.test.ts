/**
 * The estimate detail names the customer and, for an office "Mark sold", who
 * recorded it (from the audit log) instead of the "(admin)" marker.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/lib/db";
import { getEstimateDetailById } from "./estimate-queries";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));
vi.mock("@/lib/crypto", () => ({ decrypt: (c: string) => `dec(${c})` }));

/** Each db.select() resolves to the next rows; every chain method continues. */
function mockSelectSeq(results: unknown[][]): void {
  let i = 0;
  vi.mocked(db.select).mockImplementation((() => {
    const rows = results[i++] ?? [];
    const chain = Promise.resolve(rows) as unknown as Record<string, unknown>;
    for (const m of ["from", "where", "leftJoin", "innerJoin", "orderBy", "limit"]) {
      chain[m] = () => chain;
    }
    return chain;
  }) as never);
}

const HEADER = {
  id: "est-1", status: "sold", totalCents: 0, customerId: "c1", serviceRequestId: null,
  soldOptionId: "opt-1", signedAt: new Date(), expiresAt: null, createdAt: new Date(),
  dueDate: null, fieldpulseEstimateId: null, fieldpulseStatusName: null, title: null,
  fieldpulseData: null, nameEncrypted: "ENC",
};

beforeEach(() => vi.clearAllMocks());

describe("getEstimateDetailById — people", () => {
  it("names the customer and the staff member who marked it sold", async () => {
    mockSelectSeq([
      [{ ...HEADER, signatureName: "(admin)" }],
      [{ name: "Dana Whitfield" }], // audit log → users
      [], // options
    ]);
    const d = await getEstimateDetailById("org-1", "est-1");
    expect(d?.customerName).toBe("dec(ENC)");
    expect(d?.markedSoldBy).toBe("Dana Whitfield");
  });

  it("does not look up an office actor when the customer signed", async () => {
    mockSelectSeq([[{ ...HEADER, signatureName: "Trevor Nunn" }], []]);
    const d = await getEstimateDetailById("org-1", "est-1");
    expect(d?.markedSoldBy).toBeNull();
    expect(db.select).toHaveBeenCalledTimes(2); // header + options only
  });

  it("carries the generated invoice id so the page shows View invoice", async () => {
    mockSelectSeq([[{ ...HEADER, signatureName: "Trevor Nunn", invoiceId: "inv-9" }], []]);
    expect((await getEstimateDetailById("org-1", "est-1"))?.invoiceId).toBe("inv-9");
    mockSelectSeq([[{ ...HEADER, signatureName: "Trevor Nunn" }], []]);
    expect((await getEstimateDetailById("org-1", "est-1"))?.invoiceId).toBeNull();
  });
});
