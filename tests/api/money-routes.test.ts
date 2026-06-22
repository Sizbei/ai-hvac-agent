import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Route-guard tests for the three money routes. These exercise the auth/role
 * gates, the awaited params Promise, and the audit no-PII contract — NOT the DB.
 * Everything below the guard (invoice-queries, the provider) is mocked.
 */

const {
  mockGetAdminSession,
  mockTakePayment,
  mockRefundPayment,
  mockCreateEstimate,
  mockListEstimates,
  mockGetDefaultTaxBps,
  mockGetPricebookItemById,
  mockLogAudit,
  mockTriggerEstimateSent,
  mockTriggerPaymentReceipt,
  mockProcessPendingJobs,
  mockDbSelect,
  capturedAfterCallbacks,
} = vi.hoisted(() => ({
  mockGetAdminSession: vi.fn(),
  mockTakePayment: vi.fn(),
  mockRefundPayment: vi.fn(),
  mockCreateEstimate: vi.fn(),
  mockListEstimates: vi.fn(),
  mockGetDefaultTaxBps: vi.fn(),
  mockGetPricebookItemById: vi.fn(),
  mockLogAudit: vi.fn(),
  mockTriggerEstimateSent: vi.fn(),
  mockTriggerPaymentReceipt: vi.fn(),
  mockProcessPendingJobs: vi.fn(),
  mockDbSelect: vi.fn(),
  capturedAfterCallbacks: [] as Array<() => unknown | Promise<unknown>>,
}));

// Capture after() callbacks so we can run them deterministically and assert the
// best-effort receipt / estimate-send side effects (Next's real after() is a
// no-op outside a request scope).
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (cb: () => unknown) => {
      capturedAfterCallbacks.push(cb);
    },
  };
});

async function flushAfter(): Promise<void> {
  const cbs = capturedAfterCallbacks.splice(0);
  for (const cb of cbs) await cb();
}

vi.mock("@/lib/communication/money-triggers", () => ({
  triggerEstimateSent: (...a: unknown[]) => mockTriggerEstimateSent(...a),
  triggerPaymentReceipt: (...a: unknown[]) => mockTriggerPaymentReceipt(...a),
}));
vi.mock("@/lib/communication/job-queue", () => ({
  processPendingJobs: (...a: unknown[]) => mockProcessPendingJobs(...a),
}));
vi.mock("@/lib/db", () => ({ db: { select: (...a: unknown[]) => mockDbSelect(...a) } }));
vi.mock("@/lib/db/tenant", () => ({ withTenant: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
}));
vi.mock("@/lib/admin/invoice-queries", () => ({
  takePayment: (...a: unknown[]) => mockTakePayment(...a),
  refundPayment: (...a: unknown[]) => mockRefundPayment(...a),
}));
vi.mock("@/lib/admin/estimate-queries", () => ({
  listEstimates: (...a: unknown[]) => mockListEstimates(...a),
  createEstimate: (...a: unknown[]) => mockCreateEstimate(...a),
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({
  getDefaultTaxBps: (...a: unknown[]) => mockGetDefaultTaxBps(...a),
  getPricebookItemById: (...a: unknown[]) => mockGetPricebookItemById(...a),
}));
vi.mock("@/lib/admin/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: vi.fn(() => ({ allowed: true })),
  RATE_LIMITS: {
    adminMutation: { maxRequests: 100, windowMs: 60000 },
    adminRead: { maxRequests: 100, windowMs: 60000 },
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// isSuperAdmin is pure — re-implement it against the mocked session role so the
// refund route's role gate is exercised for real.
vi.mock("@/lib/auth/authz", () => ({
  isSuperAdmin: (s: { role: string }) => s.role === "super_admin",
}));

import { POST as refundPOST } from "@/app/api/admin/payments/[id]/refund/route";
import { POST as takePaymentPOST } from "@/app/api/admin/invoices/[id]/payments/route";
import { POST as estimatesPOST, GET as estimatesGET } from "@/app/api/admin/estimates/route";

const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-0000000000aa";

function session(role: "super_admin" | "admin") {
  return { userId: USER, organizationId: ORG, email: "a@b.co", name: "A", role };
}

function jsonReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedAfterCallbacks.length = 0;
  mockLogAudit.mockResolvedValue(undefined);
  mockGetDefaultTaxBps.mockResolvedValue(0);
  mockCreateEstimate.mockResolvedValue({
    estimateId: "est-1",
    approvalToken: "tok-1",
  });
  mockTriggerEstimateSent.mockResolvedValue(undefined);
  mockTriggerPaymentReceipt.mockResolvedValue(undefined);
  mockProcessPendingJobs.mockResolvedValue({ processed: 0, succeeded: 0, failed: 0 });
  // Default invoice lookup in the receipt after() path returns a customer.
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve([{ customerId: "cust-1" }]) }),
    }),
  });
});

const PB_ID = "11111111-1111-4111-8111-1111111111c1";

describe("POST /api/admin/payments/[id]/refund — role gate", () => {
  it("returns 401 when there is no admin session", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await refundPOST(
      jsonReq("/api/admin/payments/pay-1/refund", {
        amountCents: 1000,
        reason: "duplicate",
      }),
      { params: Promise.resolve({ id: "pay-1" }) },
    );
    expect(res.status).toBe(401);
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-super_admin (admin) session", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    const res = await refundPOST(
      jsonReq("/api/admin/payments/pay-1/refund", {
        amountCents: 1000,
        reason: "duplicate",
      }),
      { params: Promise.resolve({ id: "pay-1" }) },
    );
    expect(res.status).toBe(403);
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  it("proceeds for a super_admin and awaits the params Promise", async () => {
    mockGetAdminSession.mockResolvedValue(session("super_admin"));
    mockRefundPayment.mockResolvedValue({ ok: true, refundId: "ref-1" });
    const res = await refundPOST(
      jsonReq("/api/admin/payments/pay-1/refund", {
        amountCents: 1000,
        reason: "duplicate",
      }),
      { params: Promise.resolve({ id: "pay-1" }) },
    );
    expect(res.status).toBe(201);
    // The id came from the awaited params Promise.
    expect(mockRefundPayment).toHaveBeenCalledWith(
      ORG,
      "pay-1",
      expect.objectContaining({ amountCents: 1000, reason: "duplicate" }),
    );
  });

  it("surfaces a read-only synced invoice as 409 (not 500) on refund", async () => {
    mockGetAdminSession.mockResolvedValue(session("super_admin"));
    mockRefundPayment.mockResolvedValue({ ok: false, reason: "synced_read_only" });
    const res = await refundPOST(
      jsonReq("/api/admin/payments/pay-1/refund", {
        amountCents: 1000,
        reason: "customer_request",
      }),
      { params: Promise.resolve({ id: "pay-1" }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("audit details carry NO PII — only ids/cents/enum", async () => {
    mockGetAdminSession.mockResolvedValue(session("super_admin"));
    mockRefundPayment.mockResolvedValue({ ok: true, refundId: "ref-1" });
    await refundPOST(
      jsonReq("/api/admin/payments/pay-1/refund", {
        amountCents: 1000,
        reason: "customer_request",
      }),
      { params: Promise.resolve({ id: "pay-1" }) },
    );
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const details = mockLogAudit.mock.calls[0][0].details as string;
    expect(details).toBe("refundId:ref-1 amountCents:1000 reason:customer_request");
    // No email / phone / free-text name patterns.
    expect(details).not.toMatch(/@/);
    expect(details).not.toMatch(/\b\d{3}[-.]\d{3}[-.]\d{4}\b/);
  });
});

describe("POST /api/admin/invoices/[id]/payments — admin session required", () => {
  it("returns 401 when there is no admin session", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await takePaymentPOST(
      jsonReq("/api/admin/invoices/inv-1/payments", { amountCents: 5000 }),
      { params: Promise.resolve({ id: "inv-1" }) },
    );
    expect(res.status).toBe(401);
    expect(mockTakePayment).not.toHaveBeenCalled();
  });

  it("proceeds for an admin session and awaits params", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockTakePayment.mockResolvedValue({
      ok: true,
      paymentId: "pay-1",
      invoiceState: "paid",
    });
    const res = await takePaymentPOST(
      jsonReq("/api/admin/invoices/inv-1/payments", { amountCents: 5000 }),
      { params: Promise.resolve({ id: "inv-1" }) },
    );
    expect(res.status).toBe(201);
    expect(mockTakePayment).toHaveBeenCalledWith(
      ORG,
      "inv-1",
      expect.objectContaining({ amountCents: 5000 }),
    );
  });

  it("surfaces a read-only synced invoice as 409 (not 500), with no receipt", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockTakePayment.mockResolvedValue({ ok: false, reason: "synced_read_only" });
    const res = await takePaymentPOST(
      jsonReq("/api/admin/invoices/inv-1/payments", { amountCents: 5000 }),
      { params: Promise.resolve({ id: "inv-1" }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INVOICE_SYNCED_READ_ONLY");
    // A blocked charge must NOT enqueue a receipt.
    await flushAfter();
    expect(mockTriggerPaymentReceipt).not.toHaveBeenCalled();
  });

  it("enqueues a payment_receipt and drains the queue on a successful payment", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockTakePayment.mockResolvedValue({
      ok: true,
      paymentId: "pay-1",
      invoiceState: "paid",
    });
    const res = await takePaymentPOST(
      jsonReq("/api/admin/invoices/inv-1/payments", { amountCents: 5000 }),
      { params: Promise.resolve({ id: "inv-1" }) },
    );
    expect(res.status).toBe(201);
    // The receipt work runs in after() — flush it.
    await flushAfter();
    expect(mockTriggerPaymentReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        invoiceId: "inv-1",
        customerId: "cust-1",
        amountCents: 5000,
      }),
    );
    expect(mockProcessPendingJobs).toHaveBeenCalledTimes(1);
  });

  it("does NOT enqueue a receipt when the charge failed", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockTakePayment.mockResolvedValue({ ok: false, reason: "charge_failed" });
    const res = await takePaymentPOST(
      jsonReq("/api/admin/invoices/inv-1/payments", { amountCents: 5000 }),
      { params: Promise.resolve({ id: "inv-1" }) },
    );
    expect(res.status).toBe(402);
    await flushAfter();
    expect(mockTriggerPaymentReceipt).not.toHaveBeenCalled();
  });

  it("a receipt failure does NOT fail the payment (best-effort)", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockTakePayment.mockResolvedValue({
      ok: true,
      paymentId: "pay-1",
      invoiceState: "paid",
    });
    mockTriggerPaymentReceipt.mockRejectedValue(new Error("twilio down"));
    const res = await takePaymentPOST(
      jsonReq("/api/admin/invoices/inv-1/payments", { amountCents: 5000 }),
      { params: Promise.resolve({ id: "inv-1" }) },
    );
    // Response already 201 before after() runs; the error is swallowed.
    expect(res.status).toBe(201);
    await expect(flushAfter()).resolves.toBeUndefined();
  });
});

describe("/api/admin/estimates — admin session required", () => {
  it("GET returns 401 when there is no admin session", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await estimatesGET();
    expect(res.status).toBe(401);
    expect(mockListEstimates).not.toHaveBeenCalled();
  });

  it("POST returns 401 when there is no admin session", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await estimatesPOST(
      jsonReq("/api/admin/estimates", {
        options: [{ name: "Opt", lineItems: [{ name: "x", quantity: 1, unitPriceCents: 100 }] }],
      }),
    );
    expect(res.status).toBe(401);
    expect(mockCreateEstimate).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/estimates — server-authoritative pricing (anti-tampering)", () => {
  it("prices a catalog line from the pricebook item, IGNORING client unitPriceCents", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    // The real catalog price/cost the server must use.
    mockGetPricebookItemById.mockResolvedValue({
      id: PB_ID,
      organizationId: ORG,
      name: "Real Catalog Item",
      priceCents: 50000,
      memberPriceCents: 45000,
      costCents: 20000,
      active: true,
    });

    const res = await estimatesPOST(
      jsonReq("/api/admin/estimates", {
        options: [
          {
            name: "Good",
            lineItems: [
              {
                pricebookItemId: PB_ID,
                // Tampered client values — must be discarded by the server.
                name: "Spoofed Name",
                unitPriceCents: 1, // attacker tries to pay 1 cent
                quantity: 2,
              },
            ],
          },
        ],
      }),
    );

    expect(res.status).toBe(201);
    expect(mockCreateEstimate).toHaveBeenCalledTimes(1);
    const passed = mockCreateEstimate.mock.calls[0][1] as {
      options: Array<{
        lineItems: Array<{
          name: string;
          unitPriceCents: number;
          costCents: number;
          pricebookItemId: string | null;
        }>;
      }>;
    };
    const line = passed.options[0].lineItems[0];
    // Price + name + cost come from the pricebook item, NOT the client.
    expect(line.unitPriceCents).toBe(50000);
    expect(line.name).toBe("Real Catalog Item");
    expect(line.costCents).toBe(20000);
    expect(line.pricebookItemId).toBe(PB_ID);
  });

  it("uses member price when useMemberPrice is set", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockGetPricebookItemById.mockResolvedValue({
      id: PB_ID,
      organizationId: ORG,
      name: "Item",
      priceCents: 50000,
      memberPriceCents: 45000,
      costCents: 20000,
      active: true,
    });

    await estimatesPOST(
      jsonReq("/api/admin/estimates", {
        options: [
          {
            name: "Good",
            lineItems: [
              { pricebookItemId: PB_ID, quantity: 1, useMemberPrice: true },
            ],
          },
        ],
      }),
    );

    const passed = mockCreateEstimate.mock.calls[0][1] as {
      options: Array<{ lineItems: Array<{ unitPriceCents: number }> }>;
    };
    expect(passed.options[0].lineItems[0].unitPriceCents).toBe(45000);
  });

  it("rejects a catalog line whose item went inactive (clean 400, no 500)", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockGetPricebookItemById.mockResolvedValue({
      id: PB_ID,
      organizationId: ORG,
      name: "Item",
      priceCents: 50000,
      memberPriceCents: null,
      costCents: 20000,
      active: false, // went inactive between list and submit
    });

    const res = await estimatesPOST(
      jsonReq("/api/admin/estimates", {
        options: [
          { name: "Good", lineItems: [{ pricebookItemId: PB_ID, quantity: 1 }] },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(mockCreateEstimate).not.toHaveBeenCalled();
  });

  it("rejects a manual line missing name/price (400)", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    const res = await estimatesPOST(
      jsonReq("/api/admin/estimates", {
        // No pricebookItemId and no name/price -> manual line is incomplete.
        options: [{ name: "Good", lineItems: [{ quantity: 1 }] }],
      }),
    );
    expect(res.status).toBe(400);
    expect(mockCreateEstimate).not.toHaveBeenCalled();
  });

  it("accepts a valid manual line with costCents 0", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    const res = await estimatesPOST(
      jsonReq("/api/admin/estimates", {
        options: [
          {
            name: "Good",
            lineItems: [{ name: "Custom work", quantity: 1, unitPriceCents: 12500 }],
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const passed = mockCreateEstimate.mock.calls[0][1] as {
      options: Array<{ lineItems: Array<{ costCents: number; unitPriceCents: number }> }>;
    };
    expect(passed.options[0].lineItems[0].costCents).toBe(0);
    expect(passed.options[0].lineItems[0].unitPriceCents).toBe(12500);
  });

  it("sends the approval link to the customer when sendToCustomer + customerId are set", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
    const res = await estimatesPOST(
      jsonReq("/api/admin/estimates", {
        customerId: CUSTOMER_ID,
        sendToCustomer: true,
        options: [
          { name: "Good", lineItems: [{ name: "x", quantity: 1, unitPriceCents: 100 }] },
        ],
      }),
    );
    expect(res.status).toBe(201);
    await flushAfter();
    expect(mockTriggerEstimateSent).toHaveBeenCalledTimes(1);
    const arg = mockTriggerEstimateSent.mock.calls[0][0] as {
      organizationId: string;
      customerId: string;
      approvalUrl: string;
    };
    expect(arg.organizationId).toBe(ORG);
    expect(arg.customerId).toBe(CUSTOMER_ID);
    expect(arg.approvalUrl).toContain("/estimates/tok-1"); // built from the token
  });

  it("does NOT send to the customer when sendToCustomer is omitted", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    const res = await estimatesPOST(
      jsonReq("/api/admin/estimates", {
        customerId: "22222222-2222-4222-8222-222222222222",
        options: [
          { name: "Good", lineItems: [{ name: "x", quantity: 1, unitPriceCents: 100 }] },
        ],
      }),
    );
    expect(res.status).toBe(201);
    await flushAfter();
    expect(mockTriggerEstimateSent).not.toHaveBeenCalled();
  });
});
