import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Regression guard for the portal pay route's rejection handling. The route
 * maps payPortalInvoice's failure reasons to HTTP responses. A reason that the
 * switch does NOT handle must NEVER fall through to the success response — that
 * would tell a customer "paid: true" for a payment that did not happen.
 */
const { mockResolvePortalToken, mockPayPortalInvoice, mockAuditInsert } =
  vi.hoisted(() => ({
    mockResolvePortalToken: vi.fn(),
    mockPayPortalInvoice: vi.fn(),
    mockAuditInsert: vi.fn(),
  }));

vi.mock("@/lib/portal/portal-queries", () => ({
  resolvePortalToken: (...a: unknown[]) => mockResolvePortalToken(...a),
  payPortalInvoice: (...a: unknown[]) => mockPayPortalInvoice(...a),
}));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: vi.fn(() => ({ allowed: true })),
}));
vi.mock("@/lib/db", () => ({
  db: { insert: () => ({ values: () => ({ catch: mockAuditInsert }) }) },
}));
vi.mock("@/lib/db/schema", () => ({ auditLog: {} }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { POST as payPOST } from "@/app/api/portal/[token]/pay/route";

const ORG = "00000000-0000-0000-0000-000000000001";
const CUST = "00000000-0000-0000-0000-0000000000bb";
const INV = "11111111-1111-4111-8111-1111111111c1";

function payReq(amountCents: number): NextRequest {
  return new NextRequest("http://localhost:3000/api/portal/tok-1/pay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invoiceId: INV, amountCents }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolvePortalToken.mockResolvedValue({
    organizationId: ORG,
    customerId: CUST,
  });
  mockAuditInsert.mockResolvedValue(undefined);
});

describe("POST /api/portal/[token]/pay — rejection handling", () => {
  it("returns 422 (NOT a false success) when the amount exceeds the balance", async () => {
    mockPayPortalInvoice.mockResolvedValue({ ok: false, reason: "exceeds_balance" });
    const res = await payPOST(payReq(999_999), {
      params: Promise.resolve({ token: "tok-1" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 409 for a synced (read-only) invoice — never reports it as paid", async () => {
    mockPayPortalInvoice.mockResolvedValue({ ok: false, reason: "synced_read_only" });
    const res = await payPOST(payReq(1000), {
      params: Promise.resolve({ token: "tok-1" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 200 paid:true only on a real success", async () => {
    mockPayPortalInvoice.mockResolvedValue({ ok: true, invoiceState: "paid" });
    const res = await payPOST(payReq(1000), {
      params: Promise.resolve({ token: "tok-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.paid).toBe(true);
  });
});
