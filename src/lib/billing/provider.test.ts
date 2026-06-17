import { describe, it, expect, vi } from "vitest";
import { MockSaaSBillingProvider, getBillingProvider } from "./provider";

describe("MockSaaSBillingProvider", () => {
  const p = new MockSaaSBillingProvider();

  it("returns a deterministic placeholder checkout URL", async () => {
    const { url } = await p.createCheckoutSession({
      orgId: "org-1",
      planId: "pro",
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
    });
    expect(url).toBe("https://example.test/billing/checkout/org-1/pro");
  });

  it("returns a deterministic placeholder portal URL", async () => {
    const { url } = await p.createPortalSession({
      orgId: "org-1",
      returnUrl: "https://app/back",
    });
    expect(url).toBe("https://example.test/billing/portal/org-1");
  });
});

describe("getBillingProvider", () => {
  it("returns the mock when no Stripe key is set", () => {
    const prev = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      expect(getBillingProvider().name).toBe("mock");
    } finally {
      if (prev !== undefined) process.env.STRIPE_SECRET_KEY = prev;
    }
  });

  it("warns LOUDLY but still mocks when STRIPE_SECRET_KEY is set", () => {
    const prev = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const provider = getBillingProvider();
      expect(provider.name).toBe("mock");
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toContain("STRIPE_SECRET_KEY is set");
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prev;
    }
  });
});
