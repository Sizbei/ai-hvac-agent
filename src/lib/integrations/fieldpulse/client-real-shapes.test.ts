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
});
