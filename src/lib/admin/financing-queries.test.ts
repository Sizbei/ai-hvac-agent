import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createFinancingApplication,
  updateFinancingStatusByProviderId,
} from "./financing-queries";
import { db } from "@/lib/db";
import { MockFinancingProvider } from "@/lib/financing/provider";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
  },
}));

const ORG = "org-1";
const EST = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  } as never);
});

/** Sequence db.select results; each where() is awaitable AND .limit()-able. */
function mockSelectSeq(results: unknown[][]) {
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

describe("createFinancingApplication", () => {
  it("creates a pending application for an estimate (provider called once)", async () => {
    mockSelectSeq([[]]); // no existing application
    const provider = new MockFinancingProvider();
    const spy = vi.spyOn(provider, "createApplication");

    const r = await createFinancingApplication(
      ORG,
      { estimateId: EST, requestedAmountCents: 50000 },
      provider,
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.application.status).toBe("pending");
      expect(r.application.applyUrl).toContain("https://");
    }
    expect(spy).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: an existing application is returned and the provider is NOT called again", async () => {
    mockSelectSeq([
      [
        {
          id: "fin-1",
          status: "pending",
          requestedAmountCents: 50000,
          estimateId: EST,
          customerId: null,
          providerAppId: "mock_fin_existing",
        },
      ],
    ]);
    const provider = new MockFinancingProvider();
    const spy = vi.spyOn(provider, "createApplication");

    const r = await createFinancingApplication(
      ORG,
      { estimateId: EST, requestedAmountCents: 50000 },
      provider,
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.application.id).toBe("fin-1");
    expect(spy).not.toHaveBeenCalled(); // no duplicate application
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("uses the invoice id as the idempotency key for invoice-initiated applications", async () => {
    const INV = "22222222-2222-2222-2222-222222222222";
    mockSelectSeq([
      [{ estimateId: EST, customerId: "cust-1" }], // invoice lookup
      [], // no existing application
    ]);
    const provider = new MockFinancingProvider();
    const spy = vi.spyOn(provider, "createApplication");

    const r = await createFinancingApplication(
      ORG,
      { invoiceId: INV, requestedAmountCents: 30000 },
      provider,
    );

    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: INV }),
    );
  });

  it("returns invoice_not_found when the invoice is missing", async () => {
    mockSelectSeq([[]]); // invoice lookup empty
    const r = await createFinancingApplication(
      ORG,
      { invoiceId: "22222222-2222-2222-2222-222222222222", requestedAmountCents: 30000 },
      new MockFinancingProvider(),
    );
    expect(r).toEqual({ ok: false, reason: "invoice_not_found" });
  });

  it("returns no_estimate_link when the invoice has no estimate", async () => {
    mockSelectSeq([[{ estimateId: null, customerId: "cust-1" }]]);
    const r = await createFinancingApplication(
      ORG,
      { invoiceId: "22222222-2222-2222-2222-222222222222", requestedAmountCents: 30000 },
      new MockFinancingProvider(),
    );
    expect(r).toEqual({ ok: false, reason: "no_estimate_link" });
  });

  it("never stores or returns an APR / rate / monthly-payment field", async () => {
    mockSelectSeq([[]]);
    const provider = new MockFinancingProvider();
    const r = await createFinancingApplication(
      ORG,
      { estimateId: EST, requestedAmountCents: 50000 },
      provider,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const keys = Object.keys(r.application).map((k) => k.toLowerCase());
      for (const banned of ["apr", "rate", "interest", "monthly", "term"]) {
        expect(keys.some((k) => k.includes(banned))).toBe(false);
      }
    }
    // The persisted row must not carry a rate either.
    const insertedValues = vi.mocked(db.insert).mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    const stored = insertedValues.values.mock.calls[0][0] as Record<string, unknown>;
    const storedKeys = Object.keys(stored).map((k) => k.toLowerCase());
    for (const banned of ["apr", "rate", "interest", "monthly", "term"]) {
      expect(storedKeys.some((k) => k.includes(banned))).toBe(false);
    }
  });
});

describe("updateFinancingStatusByProviderId", () => {
  it("advances a pending application to approved", async () => {
    mockSelectSeq([[{ id: "fin-1", status: "pending" }]]);
    const r = await updateFinancingStatusByProviderId(ORG, "mock_fin_x", "approved");
    expect(r).toEqual({ ok: true, outcome: "updated" });
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a terminal status is NOT regressed (no-op, no write)", async () => {
    mockSelectSeq([[{ id: "fin-1", status: "approved" }]]);
    const r = await updateFinancingStatusByProviderId(ORG, "mock_fin_x", "declined");
    expect(r).toEqual({ ok: true, outcome: "noop" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("no-ops when the status is unchanged", async () => {
    mockSelectSeq([[{ id: "fin-1", status: "pending" }]]);
    const r = await updateFinancingStatusByProviderId(ORG, "mock_fin_x", "pending");
    expect(r).toEqual({ ok: true, outcome: "noop" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns not_found when no application matches the provider id", async () => {
    mockSelectSeq([[]]);
    const r = await updateFinancingStatusByProviderId(ORG, "missing", "approved");
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });
});
