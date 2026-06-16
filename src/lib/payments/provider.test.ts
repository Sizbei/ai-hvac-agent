import { describe, it, expect } from "vitest";
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

  it("refunds the requested amount", async () => {
    const r = await p.refund({ providerPaymentId: "mock_pay_k1", amountCents: 2000 });
    expect(r.amountCents).toBe(2000);
    expect(r.providerRefundId).toContain("mock_ref_");
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
});
