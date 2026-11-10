/**
 * The estimate detail names the customer and, for an office "Mark sold", who
 * recorded it (from the audit log) instead of the "(admin)" marker.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/lib/db";
import { getEstimateDetailById } from "./estimate-queries";
import { VISIBLE_ONLY } from "./visibility";

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
    const d = await getEstimateDetailById("org-1", "est-1", VISIBLE_ONLY);
    expect(d?.customerName).toBe("dec(ENC)");
    expect(d?.markedSoldBy).toBe("Dana Whitfield");
  });

  it("does not look up an office actor when the customer signed", async () => {
    mockSelectSeq([[{ ...HEADER, signatureName: "Trevor Nunn" }], []]);
    const d = await getEstimateDetailById("org-1", "est-1", VISIBLE_ONLY);
    expect(d?.markedSoldBy).toBeNull();
    expect(db.select).toHaveBeenCalledTimes(2); // header + options only
  });

  it("carries the generated invoice id so the page shows View invoice", async () => {
    mockSelectSeq([[{ ...HEADER, signatureName: "Trevor Nunn", invoiceId: "inv-9" }], []]);
    expect((await getEstimateDetailById("org-1", "est-1", VISIBLE_ONLY))?.invoiceId).toBe("inv-9");
    mockSelectSeq([[{ ...HEADER, signatureName: "Trevor Nunn" }], []]);
    expect((await getEstimateDetailById("org-1", "est-1", VISIBLE_ONLY))?.invoiceId).toBeNull();
  });
});

describe("getEstimateDetailById — who sold it (M3c)", () => {
  it("a field sale carries sold_via and the technician's name, and skips the audit lookup", async () => {
    mockSelectSeq([[{ ...HEADER, signatureName: "Pat Probe", soldVia: "field", soldByName: "Sam Tech" }], []]);
    const d = await getEstimateDetailById("org-1", "est-1", VISIBLE_ONLY);
    expect(d).toMatchObject({ soldVia: "field", soldByName: "Sam Tech", markedSoldBy: null });
    expect(db.select).toHaveBeenCalledTimes(2); // header + options only
  });
  it("an office sale since M3c names the admin from sold_by, not the audit log", async () => {
    mockSelectSeq([[{ ...HEADER, signatureName: "(admin)", soldVia: "office", soldByName: "Raymond" }], []]);
    const d = await getEstimateDetailById("org-1", "est-1", VISIBLE_ONLY);
    expect(d).toMatchObject({ soldVia: "office", soldByName: "Raymond", markedSoldBy: null });
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});

describe("getEstimateDetailById — billed on the job's invoice (final review B P2-1)", () => {
  it("no office invoice: the job invoice holding the sold lines is jobInvoiceId", async () => {
    mockSelectSeq([[{ ...HEADER, signatureName: "Pat Probe", soldVia: "field", billingInvoiceId: "job-inv" }], []]);
    const d = await getEstimateDetailById("org-1", "est-1", VISIBLE_ONLY);
    expect(d).toMatchObject({ invoiceId: null, jobInvoiceId: "job-inv" });
    expect(Object.keys(vi.mocked(db.select).mock.calls[0]![0] as object)).toContain("billingInvoiceId");
  });
  it("an office invoice wins: jobInvoiceId is null", async () => {
    mockSelectSeq([[{ ...HEADER, signatureName: "Pat Probe", invoiceId: "office-inv", billingInvoiceId: "office-inv" }], []]);
    expect(await getEstimateDetailById("org-1", "est-1", VISIBLE_ONLY)).toMatchObject({ invoiceId: "office-inv", jobInvoiceId: null });
  });
  it("not billed: both null", async () => {
    mockSelectSeq([[{ ...HEADER, signatureName: "Pat Probe", billingInvoiceId: null }], []]);
    expect(await getEstimateDetailById("org-1", "est-1", VISIBLE_ONLY)).toMatchObject({ invoiceId: null, jobInvoiceId: null });
  });
});
