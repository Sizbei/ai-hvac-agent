/**
 * SaaS-billing provider SEAM (Stage 10).
 *
 * The only surface the platform-subscription code calls to start a checkout or
 * open the customer portal. A real Stripe Billing implementation drops in behind
 * this interface when STRIPE_SECRET_KEY (+ price ids) are configured; until then
 * getBillingProvider() returns a deterministic MOCK so the whole
 * plan → checkout → portal → webhook flow is buildable and testable WITHOUT live
 * credentials (mirrors src/lib/payments/provider.ts and financing/provider.ts).
 *
 * DEGRADE-SAFE: with no Stripe key the mock returns placeholder URLs and the app
 * works. With a key set we STILL return the mock (the real adapter isn't built
 * yet) but log a LOUD warning so an operator is never fooled into thinking real
 * Stripe Checkout is live.
 */
export interface CheckoutSession {
  /** Where the browser is sent to complete the subscription. */
  readonly url: string;
}

export interface PortalSession {
  /** Where the browser is sent to manage the existing subscription. */
  readonly url: string;
}

export interface SaaSBillingProvider {
  /** "mock" | "stripe" — for traceability/audit. */
  readonly name: string;
  /** Begin a subscription checkout for `planId` on `orgId`. */
  createCheckoutSession(params: {
    readonly orgId: string;
    readonly planId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
  }): Promise<CheckoutSession>;
  /** Open the billing/customer portal for an org to manage its subscription. */
  createPortalSession(params: {
    readonly orgId: string;
    readonly returnUrl: string;
  }): Promise<PortalSession>;
}

/**
 * Deterministic in-memory provider used when no real billing processor is
 * configured. Returns stable placeholder URLs (derived from orgId/planId) — it
 * moves no money and creates no real subscription; the saas-billing webhook
 * (driven by a test payload) is what mutates org plan/status in the mock world.
 */
export class MockSaaSBillingProvider implements SaaSBillingProvider {
  readonly name = "mock";

  async createCheckoutSession(params: {
    orgId: string;
    planId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSession> {
    return {
      url: `https://example.test/billing/checkout/${params.orgId}/${params.planId}`,
    };
  }

  async createPortalSession(params: {
    orgId: string;
    returnUrl: string;
  }): Promise<PortalSession> {
    return {
      url: `https://example.test/billing/portal/${params.orgId}`,
    };
  }
}

/**
 * Resolve the active SaaS-billing provider. Returns the live processor when
 * configured, else the mock. TODO(stripe): instantiate a StripeBillingProvider
 * (Stripe Checkout Session + Billing Portal Session via the `stripe` SDK, using
 * STRIPE_BILLING_* price ids) when STRIPE_SECRET_KEY is set. Do NOT pull in the
 * stripe SDK before that adapter is built.
 */
export function getBillingProvider(): SaaSBillingProvider {
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (stripeKey) {
    // LOUD warning: a key is present but the Stripe Billing adapter isn't built
    // yet, so we're still mocking. Without this an operator who sets
    // STRIPE_SECRET_KEY would believe real subscriptions/charges are happening
    // when they are not. Swap this for `new StripeBillingProvider(stripeKey)`
    // when the adapter lands (mirrors payments/provider.ts).
    console.error(
      "[saas-billing] STRIPE_SECRET_KEY is set but the Stripe Billing adapter is not implemented — using MockSaaSBillingProvider. NO REAL SUBSCRIPTIONS OR CHARGES ARE PROCESSED.",
    );
    return new MockSaaSBillingProvider();
  }
  return new MockSaaSBillingProvider();
}
