/**
 * Vendor purchasing SEAM (Parity Stage 10).
 *
 * The only surface purchase-order code calls to "submit" an order to a supplier.
 * Until a real vendor API is integrated, getVendorProvider() returns a
 * deterministic MOCK whose submitOrder is a no-op that simply reports the PO as
 * accepted — the PO is an internal record. Mirrors the payments provider seam
 * (env-presence gated, LOUD warning when a credential is present but the real
 * adapter isn't built). Money is integer cents.
 */
export interface SubmitOrderResult {
  /** Provider-side order reference. For the mock, derived from the PO id. */
  readonly providerOrderId: string;
  readonly status: "submitted" | "failed";
}

export interface VendorProvider {
  /** "mock" | "<vendor>" — recorded for traceability. */
  readonly name: string;
  /**
   * Submit a purchase order to the vendor. The mock just marks it accepted; a
   * real adapter would POST the lines to the supplier's ordering API.
   */
  submitOrder(params: {
    readonly purchaseOrderId: string;
    readonly vendorName: string;
    readonly lines: ReadonlyArray<{
      readonly description: string;
      readonly quantity: number;
      readonly unitCostCents: number;
    }>;
  }): Promise<SubmitOrderResult>;
}

/**
 * Deterministic in-memory provider used when no real vendor is configured. Never
 * places a real order — the PO stays an internal record. The provider order id
 * is derived from the PO id so a retried submit is stable.
 */
export class MockVendorProvider implements VendorProvider {
  readonly name = "mock";

  async submitOrder(params: {
    purchaseOrderId: string;
  }): Promise<SubmitOrderResult> {
    return {
      providerOrderId: `mock_po_${params.purchaseOrderId}`,
      status: "submitted",
    };
  }
}

/**
 * Resolve the active vendor provider. Returns the live vendor adapter when
 * configured, else the mock. TODO(vendor): instantiate a real provider when
 * VENDOR_PURCHASING_API_KEY is set and the adapter is built.
 */
export function getVendorProvider(): VendorProvider {
  const vendorKey = process.env.VENDOR_PURCHASING_API_KEY?.trim();
  if (vendorKey) {
    // LOUD warning: a key is present but the real adapter isn't built yet, so
    // we're still mocking. Without this an operator who sets the key would
    // believe real orders are being placed when they are not.
    console.error(
      "[inventory] VENDOR_PURCHASING_API_KEY is set but the vendor adapter is not implemented — using MockVendorProvider. NO REAL ORDERS ARE PLACED.",
    );
    return new MockVendorProvider();
  }
  return new MockVendorProvider();
}
