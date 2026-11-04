import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/admin/invoices/[id]/finalize — the office finalize. Guards, the
 * invoice's request passed as the actor's requestId, reason → status/code map,
 * audit only when the state changed. The writer and the DB read are mocked.
 */

const { mockGetAdminSession, mockFinalizeInvoice, mockLogAudit, mockDbSelect, mockSlidingWindow } = vi.hoisted(() => ({
  mockGetAdminSession: vi.fn(),
  mockFinalizeInvoice: vi.fn(),
  mockLogAudit: vi.fn(),
  mockDbSelect: vi.fn(),
  mockSlidingWindow: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAdminSession: () => mockGetAdminSession() }));
vi.mock("@/lib/admin/invoice-field-writes", () => ({
  finalizeInvoice: (...a: unknown[]) => mockFinalizeInvoice(...a),
}));
vi.mock("@/lib/admin/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));
vi.mock("@/lib/db", () => ({ db: { select: (...a: unknown[]) => mockDbSelect(...a) } }));
vi.mock("@/lib/db/tenant", () => ({ withTenant: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: (...a: unknown[]) => mockSlidingWindow(...a),
  RATE_LIMITS: { adminMutation: { maxRequests: 100, windowMs: 60000 } },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "@/app/api/admin/invoices/[id]/finalize/route";

const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-0000000000aa";
const INV = "bbbbbbbb-0000-0000-0000-000000000001";
const REQ = "dddddddd-0000-0000-0000-000000000001";

function invoiceRows(rows: unknown[]) {
  mockDbSelect.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });
}

function finalize(id = INV) {
  return POST(
    new NextRequest(`http://localhost:3000/api/admin/invoices/${id}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAdminSession.mockResolvedValue({ userId: USER, organizationId: ORG, email: "a@b.co", name: "A", role: "admin" });
  mockSlidingWindow.mockReturnValue({ allowed: true });
  mockLogAudit.mockResolvedValue(undefined);
  invoiceRows([{ serviceRequestId: REQ }]);
});

describe("POST /api/admin/invoices/[id]/finalize", () => {
  it("returns 401 without an admin session", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await finalize();
    expect(res.status).toBe(401);
    expect(mockFinalizeInvoice).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-UUID id", async () => {
    const res = await finalize("nope");
    expect(res.status).toBe(400);
    expect(mockFinalizeInvoice).not.toHaveBeenCalled();
  });

  it("rate-limits on the per-user finalize key", async () => {
    mockSlidingWindow.mockReturnValue({ allowed: false });
    const res = await finalize();
    expect(res.status).toBe(429);
    expect(mockSlidingWindow).toHaveBeenCalledWith(`admin:invoice-finalize:${USER}`, 100, 60000);
    expect(mockFinalizeInvoice).not.toHaveBeenCalled();
  });

  it("returns 404 when the invoice is not in this org", async () => {
    invoiceRows([]);
    const res = await finalize();
    expect(res.status).toBe(404);
    expect(mockFinalizeInvoice).not.toHaveBeenCalled();
  });

  it("finalizes as the office with the invoice's request and audits the change", async () => {
    mockFinalizeInvoice.mockResolvedValue({ ok: true, state: "open", changed: true });
    const res = await finalize();
    expect(res.status).toBe(200);
    expect(mockFinalizeInvoice).toHaveBeenCalledWith(
      { organizationId: ORG, requestId: REQ, techUserId: null },
      INV,
    );
    expect((await res.json()).data).toEqual({ invoiceId: INV, state: "open", changed: true });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit.mock.calls[0][0]).toMatchObject({
      organizationId: ORG,
      userId: USER,
      action: "invoice_finalized",
      entity: "invoice",
      entityId: INV,
      details: `invoiceId:${INV}`,
    });
  });

  it("passes a null request for an invoice with no request", async () => {
    invoiceRows([{ serviceRequestId: null }]);
    mockFinalizeInvoice.mockResolvedValue({ ok: true, state: "open", changed: true });
    await finalize();
    expect(mockFinalizeInvoice.mock.calls[0][0]).toEqual({ organizationId: ORG, requestId: null, techUserId: null });
  });

  it("does not audit when the invoice was already open", async () => {
    mockFinalizeInvoice.mockResolvedValue({ ok: true, state: "open", changed: false });
    const res = await finalize();
    expect(res.status).toBe(200);
    expect((await res.json()).data.changed).toBe(false);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["no_lines", 409, "NO_LINES", "Add at least one item first."],
    ["invoice_locked", 409, "INVOICE_LOCKED", "This invoice is finalized. Changes need the office."],
    ["invoice_not_found", 404, "NOT_FOUND", undefined],
    ["synced_read_only", 409, "INVOICE_SYNCED_READ_ONLY", "This invoice is managed in FieldPulse."],
    ["stale", 409, "STALE", undefined],
  ])("maps %s to %i %s with no audit", async (reason, status, code, message) => {
    mockFinalizeInvoice.mockResolvedValue({ ok: false, reason });
    const res = await finalize();
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error.code).toBe(code);
    if (message) expect(body.error.message).toBe(message);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
