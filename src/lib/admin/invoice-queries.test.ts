import { describe, it, expect, beforeEach, vi } from "vitest";
import { takePayment } from "./invoice-queries";
import { db } from "@/lib/db";
import { MockPaymentProvider } from "@/lib/payments/provider";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    // update() is used to BUILD statements (passed to batch) and directly in the
    // charge-failed path; return a chainable that resolves harmlessly.
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
  },
}));

const ORG = "org-1";

function mockInvoice(row: { totalCents: number; amountPaidCents: number } | null) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [{ id: "inv-1", ...row }] : []),
      }),
    }),
  } as never);
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  } as never);
}

beforeEach(() => vi.clearAllMocks());

describe("takePayment", () => {
  const provider = new MockPaymentProvider();

  it("marks the invoice paid when fully covered", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    const r = await takePayment(ORG, "inv-1", { amountCents: 10000 }, provider);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invoiceState).toBe("paid");
    expect(db.batch).toHaveBeenCalledTimes(1); // payment + invoice update batched
  });

  it("keeps the invoice open on a partial deposit", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    const r = await takePayment(ORG, "inv-1", { amountCents: 5000, isDeposit: true }, provider);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invoiceState).toBe("open");
  });

  it("returns invoice_not_found when the invoice is missing", async () => {
    mockInvoice(null);
    const r = await takePayment(ORG, "inv-x", { amountCents: 5000 }, provider);
    expect(r).toEqual({ ok: false, reason: "invoice_not_found" });
  });

  it("reports charge_failed when the provider declines (amount <= 0)", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    const r = await takePayment(ORG, "inv-1", { amountCents: 0 }, provider);
    expect(r).toEqual({ ok: false, reason: "charge_failed" });
  });
});
