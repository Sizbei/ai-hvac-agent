import { describe, it, expect, vi } from "vitest";
import { MockPaymentProvider, getPaymentProvider } from "./provider";
import { MockFinancingProvider, getFinancingProvider } from "../financing/provider";

describe("MockPaymentProvider", () => {
  const p = new MockPaymentProvider();

  it("succeeds with a stable id derived from the idempotency key", async () => {
    const a = await p.createCharge({ amountCents: 5000, idempotencyKey: "k1" });
    const b = await p.createCharge({ amountCents: 5000, idempotencyKey: "k1" });
    expect(a.status).toBe("succeeded");
    expect(a.providerPaymentId).toBe("mock_pay_k1");
    expect(b.providerPaymentId).toBe(a.providerPaymentId); // idempotent
  });

  it("fails a non-positive charge", async () => {
    const r = await p.createCharge({ amountCents: 0, idempotencyKey: "k" });
    expect(r.status).toBe("failed");
  });

  it("refunds the requested amount with a stable, idempotency-keyed id", async () => {
    const a = await p.refund({ providerPaymentId: "mock_pay_k1", amountCents: 2000, idempotencyKey: "r1" });
    const b = await p.refund({ providerPaymentId: "mock_pay_k1", amountCents: 2000, idempotencyKey: "r1" });
    expect(a.amountCents).toBe(2000);
    expect(a.providerRefundId).toBe("mock_ref_r1");
    expect(b.providerRefundId).toBe(a.providerRefundId); // retry-stable
  });

  it("getPaymentProvider returns the mock when no Stripe key", () => {
    const prev = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    expect(getPaymentProvider().name).toBe("mock");
    if (prev !== undefined) process.env.STRIPE_SECRET_KEY = prev;
  });
});

describe("MockFinancingProvider", () => {
  it("creates a pending application with an apply URL", async () => {
    const r = await new MockFinancingProvider().createApplication({
      requestedAmountCents: 800000,
      idempotencyKey: "f1",
    });
    expect(r.status).toBe("pending");
    expect(r.providerAppId).toBe("mock_fin_f1");
    expect(r.applyUrl).toContain("mock_fin_f1");
  });

  it("getFinancingProvider returns the mock", () => {
    expect(getFinancingProvider().name).toBe("mock");
  });

  it("getFinancingProvider warns LOUDLY but still mocks when WISETACK_API_KEY is set", () => {
    const prev = process.env.WISETACK_API_KEY;
    process.env.WISETACK_API_KEY = "wt_test";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const provider = getFinancingProvider();
      expect(provider.name).toBe("mock");
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toContain("WISETACK_API_KEY is set");
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.WISETACK_API_KEY;
      else process.env.WISETACK_API_KEY = prev;
    }
  });
});
