/**
 * Consumer-financing provider SEAM (Stage 9).
 *
 * A thin hand-off: we create an application, the lender owns underwriting and
 * reports status back (webhook). A real Wisetack/GreenSky adapter drops in here
 * when a lender contract + API key exist; until then a MOCK lets the flow be
 * built/tested without a partner. We never quote APR/Reg-Z terms ourselves — the
 * provider returns them.
 */
export interface FinancingApplicationResult {
  readonly providerAppId: string;
  readonly status: "pending" | "approved" | "declined";
  readonly approvedAmountCents?: number;
  /** A link to the lender's prequalification page (what the customer opens). */
  readonly applyUrl: string;
}

export interface FinancingProvider {
  readonly name: string;
  createApplication(params: {
    readonly requestedAmountCents: number;
    readonly idempotencyKey: string;
  }): Promise<FinancingApplicationResult>;
}

/** Deterministic mock — returns a pending application + a placeholder apply URL. */
export class MockFinancingProvider implements FinancingProvider {
  readonly name = "mock";

  async createApplication(params: {
    requestedAmountCents: number;
    idempotencyKey: string;
  }): Promise<FinancingApplicationResult> {
    const providerAppId = `mock_fin_${params.idempotencyKey}`;
    return {
      providerAppId,
      status: "pending",
      applyUrl: `https://example.test/financing/${providerAppId}`,
    };
  }
}

/** Resolve the active financing provider (mock until a lender is configured). */
export function getFinancingProvider(): FinancingProvider {
  // TODO(financing): return a WisetackFinancingProvider when WISETACK_API_KEY is
  // set + a contract is in place. Mock until then.
  return new MockFinancingProvider();
}
