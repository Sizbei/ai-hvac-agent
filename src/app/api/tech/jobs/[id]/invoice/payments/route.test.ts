import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  after: vi.fn(),
  preamble: vi.fn(),
  resolveTarget: vi.fn(),
  withIdempotency: vi.fn(),
  replay: { current: null as null | { status: number; envelope: unknown } },
  recordManualPayment: vi.fn(),
  logAudit: vi.fn(),
  dbRows: vi.fn(),
  triggerPaymentReceipt: vi.fn(),
  processPendingJobs: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: h.after }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => h.dbRows() }) }) }) },
}));
vi.mock("@/lib/tech/invoice-route-guards", () => ({ techWritePreamble: h.preamble, resolveTarget: h.resolveTarget }));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("@/lib/admin/invoice-payment-writes", () => ({ recordManualPayment: h.recordManualPayment }));
vi.mock("@/lib/communication/money-triggers", () => ({ triggerPaymentReceipt: h.triggerPaymentReceipt }));
vi.mock("@/lib/communication/job-queue", () => ({ processPendingJobs: h.processPendingJobs }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", async (orig) => ({ ...(await orig<typeof import("@/lib/logger")>()), logger: { info: vi.fn(), error: h.logError, warn: vi.fn() } }));

import { POST } from "./route";
import { NextResponse } from "next/server";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const INV = "22222222-2222-4222-8222-222222222222";
const PAY = "77777777-7777-4777-8777-777777777777";
const CUST = "88888888-8888-4888-8888-888888888888";
const PATH = `/api/tech/jobs/${RID}/invoice/payments`;
const ctx = { params: Promise.resolve({ id: RID }) };
const CASH = { invoiceId: INV, method: "cash", amountCents: 12345 };
const CHECK = { invoiceId: INV, method: "check", amountCents: 12345, checkNumber: "CHK-998" };

function post(body: unknown, key: string | null = "k-1", raw?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }), ctx);
}
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
const runAfter = async () => {
  expect(h.after).toHaveBeenCalledTimes(1);
  await (h.after.mock.calls[0][0] as () => Promise<void>)();
};

beforeEach(() => {
  vi.clearAllMocks();
  h.replay.current = null;
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.resolveTarget.mockResolvedValue("ok");
  h.withIdempotency.mockImplementation(async (_scope: unknown, _hash: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    h.replay.current
      ? { ...h.replay.current, replayed: true }
      : { ...(await run({ id: (n) => (n === "payment" ? PAY : `bad-${n}`) }) as object), replayed: false });
  h.recordManualPayment.mockResolvedValue({ ok: true, paymentId: PAY, invoiceState: "open", created: true });
  h.dbRows.mockReturnValue([{ customerId: CUST }]);
  h.triggerPaymentReceipt.mockResolvedValue(undefined);
  h.processPendingJobs.mockResolvedValue(undefined);
});

describe("POST /api/tech/jobs/[id]/invoice/payments", () => {
  it("returns the preamble's response and does nothing else", async () => {
    h.preamble.mockResolvedValue({ ok: false, response: NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 }) });
    const res = await post(CASH);
    expect(res.status).toBe(401);
    expect(h.withIdempotency).not.toHaveBeenCalled();
    expect(h.recordManualPayment).not.toHaveBeenCalled();
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED without a key", async () => {
    const res = await post(CASH, null);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ success: false, error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Missing idempotency key." } });
  });

  it("400 INVALID_INPUT for bad bodies", async () => {
    const bad: unknown[] = [
      { ...CASH, amountCents: 0 },
      { ...CASH, amountCents: 100_000_001 },
      { ...CASH, amountCents: 1.5 },
      { ...CASH, amountCents: "100" },
      { ...CASH, method: "card" },
      { ...CASH, method: "other" },
      { ...CASH, checkNumber: "123" },
      { ...CHECK, checkNumber: "   " },
      { ...CHECK, checkNumber: "x".repeat(33) },
      { ...CHECK, checkNumber: "Jane Doe chk 4471" },
      { ...CHECK, checkNumber: "12/34" },
      { ...CASH, invoiceId: "nope" },
      { ...CASH, isDeposit: true },
      { method: "cash", amountCents: 100 },
    ];
    for (const body of bad) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json(res)).error).toEqual({ code: "INVALID_INPUT", message: "Couldn't save that. Try again." });
    }
    expect((await post(null, "k", "")).status).toBe(400);
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });

  it("accepts the max amount and a check without a number", async () => {
    expect((await post({ ...CASH, amountCents: 100_000_000 })).status).toBe(201);
    expect((await post({ invoiceId: INV, method: "check", amountCents: 500 })).status).toBe(201);
  });

  it("targets ANY non-void invoice of the job (an older open one too) and calls the writer", async () => {
    const res = await post(CHECK, "key_P");
    expect(res.status).toBe(201);
    expect(h.resolveTarget).toHaveBeenCalledWith(ORG, RID, INV, "any");
    expect(h.withIdempotency.mock.calls[0][0]).toEqual({ organizationId: ORG, userId: U, route: PATH, key: "key_P" });
    expect(h.recordManualPayment).toHaveBeenCalledWith(
      { organizationId: ORG, requestId: RID, techUserId: U }, INV, { paymentId: PAY },
      { method: "check", amountCents: 12345, checkNumber: "CHK-998", isDeposit: false, recordedBy: U },
    );
    expect(await json(res)).toEqual({
      success: true, data: { paymentId: PAY, invoiceId: INV, invoiceState: "open", created: true },
    });
  });

  it("trims the check number", async () => {
    await post({ ...CHECK, checkNumber: "  42  " });
    expect(h.recordManualPayment.mock.calls[0][3].checkNumber).toBe("42");
  });

  it("404 NOT_FOUND on a void or foreign invoice; the writer is not called", async () => {
    h.resolveTarget.mockResolvedValue("not_found");
    const res = await post(CASH);
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ success: false, error: { code: "NOT_FOUND", message: "No invoice on this job yet." } });
    expect(h.recordManualPayment).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
  });

  it("created with a customer: after() sends the receipt, then drains the queue", async () => {
    await post(CASH);
    expect(h.triggerPaymentReceipt).not.toHaveBeenCalled(); // only inside after()
    await runAfter();
    expect(h.triggerPaymentReceipt).toHaveBeenCalledWith({ organizationId: ORG, invoiceId: INV, customerId: CUST, amountCents: 12345 });
    expect(h.processPendingJobs).toHaveBeenCalledTimes(1);
    expect(h.triggerPaymentReceipt.mock.invocationCallOrder[0]).toBeLessThan(h.processPendingJobs.mock.invocationCallOrder[0]);
  });

  it("created without a customer: after() runs but neither the receipt nor the drain", async () => {
    h.dbRows.mockReturnValue([{ customerId: null }]);
    await post(CASH);
    await runAfter();
    expect(h.triggerPaymentReceipt).not.toHaveBeenCalled();
    expect(h.processPendingJobs).not.toHaveBeenCalled();
  });

  it("a failing receipt lookup is logged, never thrown", async () => {
    h.dbRows.mockImplementation(() => { throw new Error("db"); });
    await post(CASH);
    await expect(runAfter()).resolves.toBeUndefined();
    expect(h.logError).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: INV }), expect.any(String));
    expect(h.processPendingJobs).not.toHaveBeenCalled();
  });

  it("audits payment_recorded with ids/enums only (no amount, no check number)", async () => {
    h.recordManualPayment.mockResolvedValue({ ok: true, paymentId: PAY, invoiceState: "paid", created: true });
    await post(CHECK);
    expect(h.logAudit).toHaveBeenCalledTimes(1);
    const audit = h.logAudit.mock.calls[0][0];
    expect(audit).toMatchObject({ action: "payment_recorded", details: `paymentId:${PAY} invoiceId:${INV} method:check invoiceState:paid` });
    expect(JSON.stringify(audit)).not.toContain("12345");
    expect(JSON.stringify(audit)).not.toContain("CHK-998");
  });

  it("created: false (writer replay) is 200 with no after() and no audit", async () => {
    h.recordManualPayment.mockResolvedValue({ ok: true, paymentId: PAY, invoiceState: "paid", created: false });
    const res = await post(CASH);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ paymentId: PAY, invoiceId: INV, invoiceState: "paid", created: false });
    expect(h.after).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("key replay: no target check, no writer, no after(), no audit; stored 201 returned", async () => {
    h.replay.current = { status: 201, envelope: { success: true, data: { paymentId: PAY, invoiceId: INV, invoiceState: "paid", created: true } } };
    const res = await post(CASH);
    expect(res.status).toBe(201);
    expect((await json(res)).data).toMatchObject({ created: true, replayed: true });
    expect(h.resolveTarget).not.toHaveBeenCalled();
    expect(h.recordManualPayment).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("maps writer refusals through §6.3", async () => {
    const cases = [
      ["invoice_not_chargeable", 409, "INVOICE_NOT_CHARGEABLE"], ["exceeds_balance", 422, "EXCEEDS_BALANCE"],
      ["synced_read_only", 409, "INVOICE_SYNCED_READ_ONLY"], ["payment_id_conflict", 409, "ID_CONFLICT"],
      ["not_lead", 403, "NOT_LEAD"], ["stale", 409, "STALE"],
    ] as const;
    for (const [reason, status, code] of cases) {
      h.recordManualPayment.mockResolvedValueOnce({ ok: false, reason });
      const res = await post(CASH);
      expect(res.status).toBe(status);
      expect((await json(res)).error?.code).toBe(code);
    }
    expect(h.after).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("500 INTERNAL_ERROR when the writer throws", async () => {
    h.recordManualPayment.mockRejectedValue(new Error("boom secret"));
    const res = await post(CASH);
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });
});
