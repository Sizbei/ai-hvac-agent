/**
 * REAL-SHAPE client tests — built from payloads VERIFIED against the live
 * FieldPulse API (2026-06-19). These lock in the contract the original mocks got
 * wrong and let ship broken: numeric ids, dollar-string money, and the
 * `{ error, response }` envelope on BOTH lists and single resources.
 * See docs/superpowers/specs/2026-06-19-fieldpulse-live-api-remediation-design.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestFieldpulseClient } from "./client";
import type { FieldpulseConfig } from "./config";

describe("RestFieldpulseClient — real API shapes", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config: FieldpulseConfig = {
    baseUrl: "https://ywe3crmpll.execute-api.us-east-2.amazonaws.com/stage",
    apiKey: "test-key",
  };
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const client = () => new RestFieldpulseClient(config, mockFetch as never);

  // A trimmed real invoice: numeric ids, dollar-string money, .response wrapper.
  const REAL_INVOICE = {
    id: 20269705,
    job_id: 18783734,
    customer_id: 17101124,
    status: 3,
    total: "200.00",
    amount_paid: "0.00",
    amount_unpaid: "200.00",
    due_date: "2026-07-09 13:00:00",
    last_payment_date: null,
    created_at: "2026-06-09 19:38:06",
    // Real nesting: line_items[].line_components[] carry the money + labels.
    line_items: [
      {
        id: 176530627,
        line_title: "",
        line_components: [
          {
            title: "AC Service Tech & Helper",
            description: "Recharge of AC Unit",
            quantity: "1",
            unit_cost: "80.0000",
            unit_price: "200.0000",
          },
        ],
      },
    ],
  };

  it("getInvoice parses a wrapped single resource: numeric id, dollar→cents", async () => {
    mockFetch.mockResolvedValue(ok({ error: false, response: REAL_INVOICE }));
    const inv = await client().getInvoice("20269705");
    expect(inv).not.toBeNull();
    expect(inv!.id).toBe("20269705"); // numeric id coerced to string
    expect(inv!.jobId).toBe("18783734");
    expect(inv!.totalCents).toBe(20000); // "200.00" -> cents
    expect(inv!.amountPaidCents).toBe(0);
    expect(inv!.amountUnpaidCents).toBe(20000);
    expect(inv!.paidAt).toBeNull(); // last_payment_date, not paid_at
    // Line items flattened from line_items[].line_components[].
    expect(inv!.lineItems).toHaveLength(1);
    expect(inv!.lineItems![0]).toMatchObject({
      name: "AC Service Tech & Helper",
      quantity: 1,
      unitPriceCents: 20000, // "200.0000" -> cents
      unitCostCents: 8000, // "80.0000" -> cents (margin)
    });
  });

  it("getInvoice would have returned NULL before the fix (numeric id rejected)", async () => {
    // Regression guard: the old narrower required a string id and would reject
    // this real payload. The assertion above proves it no longer does.
    mockFetch.mockResolvedValue(ok({ error: false, response: REAL_INVOICE }));
    expect((await client().getInvoice("x"))?.totalCents).toBe(20000);
  });

  it("listJobInvoices unwraps .response AND filters client-side by job_id", async () => {
    mockFetch.mockResolvedValue(
      ok({
        error: false,
        response: [
          { ...REAL_INVOICE, id: 1, job_id: 999, total: "10.00" }, // other job
          { ...REAL_INVOICE, id: 2, job_id: 18783734, total: "50.00" }, // ours
          { ...REAL_INVOICE, id: 3, job_id: null }, // unlinked
        ],
      }),
    );
    const list = await client().listJobInvoices("18783734");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("2");
    expect(list[0].totalCents).toBe(5000);
  });

  it("getAccountInfo validates via /users and surfaces company_id (no /company)", async () => {
    mockFetch.mockResolvedValue(
      ok({ error: false, response: [{ id: 5, company_id: 182499 }] }),
    );
    const info = await client().getAccountInfo();
    expect(info.accountId).toBe("182499");
    // Probe must hit /users, not the non-existent /company route.
    expect(String(mockFetch.mock.calls[0][0])).toContain("/users");
  });

  it("listEstimates parses numeric ids, dollar-string money, and the response envelope", async () => {
    mockFetch.mockResolvedValue(
      ok({
        error: false,
        response: [
          {
            id: 70000001,
            customer_id: 20000001,
            job_id: 10000001,
            status: "2",
            subtotal: "250.00",
            tax: "20.00",
            total: "270.00",
            notes: "Replace capacitor",
            due_date: "2026-08-01",
            invoiced_date: null,
            created_at: "2026-07-01 08:00:00",
            deleted_at: null,
          },
        ],
      }),
    );
    const { items, totalCount } = await client().listEstimates(1);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("70000001"); // numeric coerced to string
    expect(items[0].customerId).toBe("20000001");
    expect(items[0].totalCents).toBe(27000); // "270.00" → cents
    expect(items[0].subtotalCents).toBe(25000);
    expect(items[0].taxCents).toBe(2000);
    expect(items[0].status).toBe("2");
    expect(totalCount).toBeNull(); // /estimates returns null total_count
  });

  it("listEstimates returns empty array when response is empty", async () => {
    mockFetch.mockResolvedValue(ok({ error: false, response: [] }));
    const { items } = await client().listEstimates(1);
    expect(items).toHaveLength(0);
  });

  it("getEstimate unwraps the custom_status OBJECT to its name (live-verified shape)", async () => {
    // Live 2026-07-09: custom_status = {id, name: "Sent", icon, color, type, ...}
    // — NOT a bare string. A string-only mapper nulled every status name in prod.
    mockFetch.mockResolvedValue(
      ok({
        error: false,
        response: {
          id: 70000001,
          customer_id: 20000001,
          status: 1,
          total: "270.00",
          custom_status: {
            id: 1878569,
            name: "Sent",
            icon: "envelope",
            color: "#57cfff",
            type: "estimate_sent",
          },
        },
      }),
    );
    const est = await client().getEstimate("70000001");
    expect(est?.customStatus).toBe("Sent");
  });

  it("listPayments parses numeric ids, dollar-string money, and the response envelope", async () => {
    mockFetch.mockResolvedValue(
      ok({
        error: false,
        response: [
          {
            id: 80000001,
            invoice_id: 50000001,
            customer_id: 20000001,
            payment_date: "2026-07-03 14:00:00",
            amount: "270.00",
            method: "check",
            status: "paid",
            deleted_at: null,
          },
        ],
      }),
    );
    const { items, totalCount } = await client().listPayments(1);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("80000001");
    expect(items[0].invoiceId).toBe("50000001");
    expect(items[0].amountCents).toBe(27000); // "270.00" → cents
    expect(items[0].method).toBe("check");
    expect(items[0].status).toBe("paid");
    expect(totalCount).toBeNull();
  });

  it("listPayments skips entries with no id", async () => {
    mockFetch.mockResolvedValue(
      ok({
        error: false,
        response: [
          { customer_id: 20000001, amount: "100.00" }, // no id
          { id: 80000002, customer_id: 20000001, amount: "200.00" },
        ],
      }),
    );
    const { items } = await client().listPayments(1);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("80000002");
  });

  it("listAssets parses numeric ids and maps all known fields", async () => {
    mockFetch.mockResolvedValue(
      ok({
        error: false,
        response: [
          {
            id: 90000001,
            customer_id: 20000001,
            title: "Carrier AC Unit",
            asset_type: "ac",
            tag: "SN-FAKE-001",
            location_description: "Backyard",
            install_date: "2020-05-15",
            maintenance_agreement_id: null,
            status: "active",
            deleted_at: null,
          },
        ],
      }),
    );
    const { items, totalCount } = await client().listAssets(1);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("90000001");
    expect(items[0].customerId).toBe("20000001");
    expect(items[0].title).toBe("Carrier AC Unit");
    expect(items[0].assetType).toBe("ac");
    expect(items[0].tag).toBe("SN-FAKE-001");
    expect(items[0].locationDescription).toBe("Backyard");
    expect(items[0].installDate).toBe("2020-05-15");
    expect(items[0].maintenanceAgreementId).toBeNull();
    expect(totalCount).toBeNull();
  });

  it("listAssets skips entries with no id", async () => {
    mockFetch.mockResolvedValue(
      ok({
        error: false,
        response: [
          { customer_id: 20000001, title: "No ID unit" }, // no id
          { id: 90000002, customer_id: 20000002, title: "Has ID" },
        ],
      }),
    );
    const { items } = await client().listAssets(1);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("90000002");
  });
});
