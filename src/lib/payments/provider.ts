/**
 * Payment provider SEAM (Stage 9).
 *
 * The only surface invoice/payment code calls. A real Stripe implementation
 * drops in behind this interface when STRIPE_SECRET_KEY is configured; until
 * then getPaymentProvider() returns a deterministic MOCK so the whole
 * estimate→invoice→deposit→refund flow is buildable and testable WITHOUT live
 * credentials (mirrors the Fieldpulse client seam). Money is integer cents.
 */
export interface PaymentResult {
  readonly providerPaymentId: string;
  readonly status: "succeeded" | "pending" | "failed";
}

export interface RefundResult {
  readonly providerRefundId: string;
  readonly amountCents: number;
}

export interface PaymentProvider {
  /** "mock" | "stripe" — recorded on the payment row for traceability. */
  readonly name: string;
  /** Charge a card. idempotencyKey makes a retried charge return the same id. */
  createCharge(params: {
    readonly amountCents: number;
    readonly currency?: string;
    readonly description?: string;
    readonly idempotencyKey: string;
  }): Promise<PaymentResult>;
  /** Refund (full or partial) a prior charge. idempotencyKey makes a retried
   * refund return the same id (so a retry after a local write failure never
   * issues a second real refund). */
  refund(params: {
    readonly providerPaymentId: string;
    readonly amountCents: number;
    readonly reason?: string;
    readonly idempotencyKey: string;
  }): Promise<RefundResult>;
}

/**
 * Deterministic in-memory provider used when no real processor is configured.
 * Always "succeeds" (id derived from the idempotency key so retries are stable)
 * — it moves money in our model only, never off-platform.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";

  async createCharge(params: {
    amountCents: number;
    idempotencyKey: string;
  }): Promise<PaymentResult> {
    if (params.amountCents <= 0) {
      return { providerPaymentId: "", status: "failed" };
    }
    return {
      providerPaymentId: `mock_pay_${params.idempotencyKey}`,
      status: "succeeded",
    };
  }

  async refund(params: {
    providerPaymentId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<RefundResult> {
    return {
      // Derived from the idempotency key so a retried refund is stable.
      providerRefundId: `mock_ref_${params.idempotencyKey}`,
      amountCents: params.amountCents,
    };
  }
}

/**
 * Resolve the active payment provider. Returns the live processor when
 * configured, else the mock. TODO(stripe): instantiate a StripePaymentProvider
 * (reuse the per-org encrypted-key pattern) when STRIPE_SECRET_KEY is set.
 */
export function getPaymentProvider(): PaymentProvider {
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (stripeKey) {
    // LOUD warning: a key is present but the Stripe adapter isn't built yet, so
    // we're still mocking. Without this an operator who sets STRIPE_SECRET_KEY
    // would believe real charges are happening when they are not. Swap this for
    // `new StripePaymentProvider(stripeKey)` when the adapter lands.
    console.error(
      "[payments] STRIPE_SECRET_KEY is set but the Stripe adapter is not implemented — using MockPaymentProvider. NO REAL CHARGES ARE PROCESSED.",
    );
    return new MockPaymentProvider();
  }
  return new MockPaymentProvider();
}
