import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  mockRecordManualPayment,
  mockCardPaymentsEnabled,
  mockGetInvoiceDetailById,
  mockGetInvoiceOrgIdentity,
  mockListInvoiceReminders,
  mockGetStorageClient,
  mockGetSignedReadUrl,
  mockCreateEstimate,
  mockListEstimates,
  mockCustomerInOrg,
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
  mockRecordManualPayment: vi.fn(),
  mockCardPaymentsEnabled: vi.fn(),
  mockGetInvoiceDetailById: vi.fn(),
  mockGetInvoiceOrgIdentity: vi.fn(),
  mockListInvoiceReminders: vi.fn(),
  mockGetStorageClient: vi.fn(),
  mockGetSignedReadUrl: vi.fn(),
  mockCreateEstimate: vi.fn(),
  mockListEstimates: vi.fn(),
  mockCustomerInOrg: vi.fn(),
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
  getInvoiceDetailById: (...a: unknown[]) => mockGetInvoiceDetailById(...a),
  getInvoiceOrgIdentity: (...a: unknown[]) => mockGetInvoiceOrgIdentity(...a),
  listInvoiceReminders: (...a: unknown[]) => mockListInvoiceReminders(...a),
}));
vi.mock("@/lib/admin/invoice-payment-writes", () => ({
  recordManualPayment: (...a: unknown[]) => mockRecordManualPayment(...a),
}));
vi.mock("@/lib/payments/card-enabled", () => ({
  cardPaymentsEnabled: () => mockCardPaymentsEnabled(),
}));
vi.mock("@/lib/storage/r2-client", () => ({
  getStorageClient: () => mockGetStorageClient(),
}));
vi.mock("@/lib/admin/estimate-queries", () => ({
  listEstimates: (...a: unknown[]) => mockListEstimates(...a),
  createEstimate: (...a: unknown[]) => mockCreateEstimate(...a),
  customerInOrg: (...a: unknown[]) => mockCustomerInOrg(...a),
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
import { GET as invoiceGET } from "@/app/api/admin/invoices/[id]/route";
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
  mockCustomerInOrg.mockResolvedValue(true);
  mockTriggerPaymentReceipt.mockResolvedValue(undefined);
  mockProcessPendingJobs.mockResolvedValue({ processed: 0, succeeded: 0, failed: 0 });
  mockCardPaymentsEnabled.mockReturnValue(false);
  // Default invoice lookup in the receipt after() path returns a customer.
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve([{ customerId: "cust-1" }]) }),
    }),
  });
});
const PAY_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const INV_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const PB_ID = "11111111-1111-4111-8111-1111111111c1";
const TOKEN = "cccccccc-1111-4111-8111-000000000001";
// officeId("payment"|"refund", ORG, TOKEN) — computed once with uuidv5 and pasted.
const OFFICE_PAYMENT_ID = "3261497a-5247-5197-bd16-fd6a894feb3a";
const OFFICE_REFUND_ID = "3bbf7525-e9e7-5bc0-9d76-069e217dadee";

const refundBody = (over: Record<string, unknown> = {}) => ({
  clientToken: TOKEN,
  amountCents: 1000,
  reason: "duplicate",
  ...over,
});

function refund(body: unknown) {
  return refundPOST(jsonReq(`/api/admin/payments/${PAY_ID}/refund`, body), {
    params: Promise.resolve({ id: PAY_ID }),
  });
}

describe("POST /api/admin/payments/[id]/refund", () => {
  it("returns 401 when there is no admin session", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await refund(refundBody());
    expect(res.status).toBe(401);
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-super_admin (admin) session", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    const res = await refund(refundBody());
    expect(res.status).toBe(403);
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  it("requires a clientToken (400, no refund)", async () => {
    mockGetAdminSession.mockResolvedValue(session("super_admin"));
    const res = await refund({ amountCents: 1000, reason: "duplicate" });
    expect(res.status).toBe(400);
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  it("derives the refund id from the org and the client token", async () => {
    mockGetAdminSession.mockResolvedValue(session("super_admin"));
    mockRefundPayment.mockResolvedValue({ ok: true, refundId: OFFICE_REFUND_ID, created: true });
    const res = await refund(refundBody());
    expect(res.status).toBe(201);
    expect(mockRefundPayment).toHaveBeenCalledWith(ORG, PAY_ID, {
      amountCents: 1000,
      reason: "duplicate",
      refundId: OFFICE_REFUND_ID,
    });
    const body = await res.json();
    expect(body.data).toEqual({ refundId: OFFICE_REFUND_ID, created: true });
  });

  it.each([
    ["refund_id_conflict", 409, "ID_CONFLICT"],
    ["invalid_input", 400, "VALIDATION_ERROR"],
    ["stale", 409, "STALE"],
    ["synced_read_only", 409, "INVOICE_SYNCED_READ_ONLY"],
  ])("maps %s to %i %s", async (reason, status, code) => {
    mockGetAdminSession.mockResolvedValue(session("super_admin"));
    mockRefundPayment.mockResolvedValue({ ok: false, reason });
    const res = await refund(refundBody());
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error.code).toBe(code);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("ID_CONFLICT carries the token-reuse copy", async () => {
    mockGetAdminSession.mockResolvedValue(session("super_admin"));
    mockRefundPayment.mockResolvedValue({ ok: false, reason: "refund_id_conflict" });
    const body = await (await refund(refundBody())).json();
    expect(body.error.message).toBe("That payment token was already used. Try again.");
  });

  it("audit details carry NO PII — only ids/enum; none on a replay", async () => {
    mockGetAdminSession.mockResolvedValue(session("super_admin"));
    mockRefundPayment.mockResolvedValue({ ok: true, refundId: "ref-1", created: true });
    await refund(refundBody({ reason: "customer_request" }));
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const details = mockLogAudit.mock.calls[0][0].details as string;
    expect(details).toBe("refundId:ref-1 reason:customer_request");

    mockLogAudit.mockClear();
    mockRefundPayment.mockResolvedValue({ ok: true, refundId: "ref-1", created: false });
    const res = await refund(refundBody({ reason: "customer_request" }));
    expect(res.status).toBe(201);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

const payBody = (over: Record<string, unknown> = {}) => ({
  clientToken: TOKEN,
  method: "cash",
  amountCents: 5000,
  ...over,
});

function pay(body: unknown) {
  return takePaymentPOST(jsonReq(`/api/admin/invoices/${INV_ID}/payments`, body), {
    params: Promise.resolve({ id: INV_ID }),
  });
}

describe("POST /api/admin/invoices/[id]/payments", () => {
  it("returns 401 when there is no admin session", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await pay(payBody());
    expect(res.status).toBe(401);
    expect(mockRecordManualPayment).not.toHaveBeenCalled();
  });

  it("refuses card while card payments are off (409, no charge)", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockCardPaymentsEnabled.mockReturnValue(false);
    const res = await pay(payBody({ method: "card" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatchObject({
      code: "CARD_PAYMENTS_UNAVAILABLE",
      message: "Online payment isn't available yet.",
    });
    expect(mockTakePayment).not.toHaveBeenCalled();
    expect(mockRecordManualPayment).not.toHaveBeenCalled();
  });

  it("charges card through takePayment when card payments are on", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockCardPaymentsEnabled.mockReturnValue(true);
    mockTakePayment.mockResolvedValue({ ok: true, paymentId: "pay-1", invoiceState: "paid" });
    const res = await pay(payBody({ method: "card", isDeposit: true }));
    expect(res.status).toBe(201);
    expect(mockTakePayment).toHaveBeenCalledWith(ORG, INV_ID, { amountCents: 5000, isDeposit: true });
    expect((await res.json()).data).toEqual({ paymentId: "pay-1", invoiceState: "paid", created: true });
    expect(mockLogAudit.mock.calls[0][0]).toMatchObject({
      action: "payment_recorded",
      details: `paymentId:pay-1 invoiceId:${INV_ID} method:card invoiceState:paid`,
    });
  });

  it("records cash with the server-derived id and the session user", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockRecordManualPayment.mockResolvedValue({
      ok: true, paymentId: OFFICE_PAYMENT_ID, invoiceState: "open", created: true,
    });
    const res = await pay(payBody());
    expect(res.status).toBe(201);
    expect(mockRecordManualPayment).toHaveBeenCalledWith(
      { organizationId: ORG, requestId: null, techUserId: null },
      INV_ID,
      { paymentId: OFFICE_PAYMENT_ID },
      { method: "cash", amountCents: 5000, checkNumber: undefined, isDeposit: false, recordedBy: USER },
    );
    expect((await res.json()).data).toEqual({
      paymentId: OFFICE_PAYMENT_ID, invoiceState: "open", created: true,
    });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit.mock.calls[0][0]).toMatchObject({
      action: "payment_recorded",
      entity: "invoice",
      entityId: INV_ID,
      details: `paymentId:${OFFICE_PAYMENT_ID} invoiceId:${INV_ID} method:cash invoiceState:open`,
    });
    expect(mockTakePayment).not.toHaveBeenCalled();
  });

  it("passes a check number with method check", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockRecordManualPayment.mockResolvedValue({
      ok: true, paymentId: OFFICE_PAYMENT_ID, invoiceState: "paid", created: true,
    });
    const res = await pay(payBody({ method: "check", checkNumber: " 1234 ", isDeposit: true }));
    expect(res.status).toBe(201);
    expect(mockRecordManualPayment.mock.calls[0][3]).toEqual({
      method: "check", amountCents: 5000, checkNumber: "1234", isDeposit: true, recordedBy: USER,
    });
  });

  it.each([
    [{ method: "cash", checkNumber: "1234" }],
    [{ clientToken: "not-a-uuid" }],
    [{ clientToken: undefined }],
    [{ method: "venmo" }],
    [{ amountCents: 0 }],
  ])("rejects an invalid body %j with 400", async (over) => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    const res = await pay(payBody(over));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(mockRecordManualPayment).not.toHaveBeenCalled();
  });

  it.each([
    ["invoice_not_found", 404, "NOT_FOUND", undefined],
    ["synced_read_only", 409, "INVOICE_SYNCED_READ_ONLY", "This invoice is managed in FieldPulse."],
    ["invoice_not_chargeable", 409, "INVOICE_NOT_CHARGEABLE", "Finalize the invoice first."],
    ["exceeds_balance", 422, "EXCEEDS_BALANCE", "That's more than the balance due."],
    ["payment_id_conflict", 409, "ID_CONFLICT", "That payment token was already used. Try again."],
    ["stale", 409, "STALE", undefined],
  ])("maps %s to %i %s with no audit or receipt", async (reason, status, code, message) => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockRecordManualPayment.mockResolvedValue({ ok: false, reason });
    const res = await pay(payBody());
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error.code).toBe(code);
    if (message) expect(body.error.message).toBe(message);
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(capturedAfterCallbacks).toHaveLength(0);
  });

  it("sends the receipt and drains the queue in one after() on a new payment with a customer", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockRecordManualPayment.mockResolvedValue({
      ok: true, paymentId: OFFICE_PAYMENT_ID, invoiceState: "paid", created: true,
    });
    const res = await pay(payBody());
    expect(res.status).toBe(201);
    expect(capturedAfterCallbacks).toHaveLength(1);
    await flushAfter();
    expect(mockTriggerPaymentReceipt).toHaveBeenCalledWith({
      organizationId: ORG, invoiceId: INV_ID, customerId: "cust-1", amountCents: 5000,
    });
    expect(mockProcessPendingJobs).toHaveBeenCalledTimes(1);
  });

  it("schedules no after() when the invoice has no customer", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockDbSelect.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ customerId: null }]) }) }),
    });
    mockRecordManualPayment.mockResolvedValue({
      ok: true, paymentId: OFFICE_PAYMENT_ID, invoiceState: "paid", created: true,
    });
    const res = await pay(payBody());
    expect(res.status).toBe(201);
    expect(capturedAfterCallbacks).toHaveLength(0);
  });

  it("a replay (created: false) returns 200 with no audit and no receipt", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockRecordManualPayment.mockResolvedValue({
      ok: true, paymentId: OFFICE_PAYMENT_ID, invoiceState: "paid", created: false,
    });
    const res = await pay(payBody());
    expect(res.status).toBe(200);
    expect((await res.json()).data.created).toBe(false);
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(capturedAfterCallbacks).toHaveLength(0);
  });

  it("a receipt failure does NOT fail the payment (best-effort)", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockRecordManualPayment.mockResolvedValue({
      ok: true, paymentId: OFFICE_PAYMENT_ID, invoiceState: "paid", created: true,
    });
    mockTriggerPaymentReceipt.mockRejectedValue(new Error("twilio down"));
    const res = await pay(payBody());
    expect(res.status).toBe(201);
    await expect(flushAfter()).resolves.toBeUndefined();
    expect(mockProcessPendingJobs).not.toHaveBeenCalled();
  });
});

const SIG_URL = "https://pub.example.com/signatures/org/req/sig.png";

function detail(over: Record<string, unknown> = {}) {
  return {
    id: INV_ID,
    payments: [{ id: PAY_ID, method: "check", checkNumber: "1234", provider: "manual", refunds: [] }],
    signature: { url: SIG_URL, name: "Pat", signedAt: "2026-11-01T10:00:00.000Z" },
    requestSignature: null,
    ...over,
  };
}

function getDetail() {
  return invoiceGET(new NextRequest(`http://localhost:3000/api/admin/invoices/${INV_ID}`), {
    params: Promise.resolve({ id: INV_ID }),
  });
}

describe("GET /api/admin/invoices/[id] — signature URLs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv("R2_PUBLIC_URL", "https://pub.example.com");
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockGetInvoiceOrgIdentity.mockResolvedValue({ name: "Org" });
    mockListInvoiceReminders.mockResolvedValue([]);
    mockGetSignedReadUrl.mockResolvedValue("https://signed.example.com/sig?x=1");
    mockGetStorageClient.mockImplementation(() => ({ getSignedReadUrl: mockGetSignedReadUrl }));
  });

  it("replaces the stored URL with a 15-minute signed read URL", async () => {
    mockGetInvoiceDetailById.mockResolvedValue(detail());
    const body = await (await getDetail()).json();
    expect(mockGetSignedReadUrl).toHaveBeenCalledWith("signatures/org/req/sig.png", 900);
    expect(body.data.invoice.signature).toEqual({
      state: "present",
      url: "https://signed.example.com/sig?x=1",
      name: "Pat",
      signedAt: "2026-11-01T10:00:00.000Z",
    });
    expect(body.data.invoice.requestSignature).toBeNull();
    expect(body.data.invoice.payments[0]).toMatchObject({
      method: "check", checkNumber: "1234", provider: "manual",
    });
  });

  it("reports none, erased and the draft's request signature", async () => {
    mockGetInvoiceDetailById.mockResolvedValue(detail({
      signature: { url: null, name: null, signedAt: null },
      requestSignature: { url: null, name: "Pat", signedAt: "2026-11-01T10:00:00.000Z" },
    }));
    const body = await (await getDetail()).json();
    expect(body.data.invoice.signature).toEqual({ state: "none", url: null, name: null, signedAt: null });
    expect(body.data.invoice.requestSignature).toMatchObject({ state: "erased", url: null });
    expect(mockGetSignedReadUrl).not.toHaveBeenCalled();
  });

  it("is unavailable (never a 500) when storage cannot sign", async () => {
    mockGetStorageClient.mockImplementation(() => {
      throw new Error("R2 not configured");
    });
    mockGetInvoiceDetailById.mockResolvedValue(detail({
      requestSignature: { url: "https://elsewhere.example.com/x.png", name: "Pat", signedAt: "2026-11-01T10:00:00.000Z" },
    }));
    const res = await getDetail();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.invoice.signature).toMatchObject({ state: "unavailable", url: null, name: "Pat" });
    expect(body.data.invoice.requestSignature).toMatchObject({ state: "unavailable", url: null });
  });
});

describe("/api/admin/estimates — admin session required", () => {
  it("GET returns 401 when there is no admin session", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await estimatesGET(new NextRequest("http://localhost:3000/api/admin/estimates"));
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

describe("POST /api/admin/estimates — customer + title (list-page New estimate)", () => {
  const OPTIONS = [{ name: "Good", lineItems: [{ name: "x", quantity: 1, unitPriceCents: 100 }] }];
  const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";

  it("refuses a customer that is not this org's, before creating anything", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    mockCustomerInOrg.mockResolvedValue(false);
    const res = await estimatesPOST(
      jsonReq("/api/admin/estimates", { customerId: CUSTOMER_ID, options: OPTIONS }),
    );
    expect(res.status).toBe(400);
    expect(mockCustomerInOrg).toHaveBeenCalledWith(ORG, CUSTOMER_ID);
    expect(mockCreateEstimate).not.toHaveBeenCalled();
  });

  it("stores a trimmed title, and none for a blank one", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    await estimatesPOST(
      jsonReq("/api/admin/estimates", { customerId: CUSTOMER_ID, title: "  Furnace replacement ", options: OPTIONS }),
    );
    expect((mockCreateEstimate.mock.calls[0][1] as { title: string | null }).title).toBe("Furnace replacement");
    await estimatesPOST(
      jsonReq("/api/admin/estimates", { customerId: CUSTOMER_ID, title: "   ", options: OPTIONS }),
    );
    expect((mockCreateEstimate.mock.calls[1][1] as { title: string | null }).title).toBeNull();
  });

  it("stays backward compatible: no customer, no title still creates", async () => {
    mockGetAdminSession.mockResolvedValue(session("admin"));
    const res = await estimatesPOST(jsonReq("/api/admin/estimates", { options: OPTIONS }));
    expect(res.status).toBe(201);
    expect(mockCustomerInOrg).not.toHaveBeenCalled();
  });
});
