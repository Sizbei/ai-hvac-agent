import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  after: vi.fn(),
  preamble: vi.fn(),
  resolveTarget: vi.fn(),
  withIdempotency: vi.fn(),
  replay: { current: null as null | { status: number; envelope: unknown } },
  addInvoiceLine: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: h.after }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/tech/invoice-route-guards", () => ({ techWritePreamble: h.preamble, resolveTarget: h.resolveTarget }));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("@/lib/admin/invoice-field-writes", () => ({ addInvoiceLine: h.addInvoiceLine }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { POST } from "./route";
import { NextResponse } from "next/server";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const INV = "22222222-2222-4222-8222-222222222222";
const PB = "33333333-3333-4333-8333-333333333333";
const MAT = "44444444-4444-4444-8444-444444444444";
const LINE = "55555555-5555-4555-8555-555555555555";
const PATH = `/api/tech/jobs/${RID}/invoice/lines`;
const ctx = { params: Promise.resolve({ id: RID }) };

function post(body: unknown, key: string | null = "k-1", raw?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, {
    method: "POST", headers, body: raw ?? JSON.stringify(body),
  }), ctx);
}
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };

beforeEach(() => {
  vi.clearAllMocks();
  h.replay.current = null;
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.resolveTarget.mockResolvedValue("ok");
  h.withIdempotency.mockImplementation(async (_scope: unknown, _hash: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    h.replay.current
      ? { ...h.replay.current, replayed: true }
      : { ...(await run({ id: (n) => (n === "line" ? LINE : `bad-${n}`) }) as object), replayed: false });
  h.addInvoiceLine.mockResolvedValue({ ok: true, lineId: LINE });
});

describe("POST /api/tech/jobs/[id]/invoice/lines", () => {
  it("returns the preamble's response and does nothing else", async () => {
    h.preamble.mockResolvedValue({ ok: false, response: NextResponse.json({ success: false, error: { code: "NOT_LEAD", message: "x" } }, { status: 403 }) });
    const res = await post({ invoiceId: INV, pricebookItemId: PB, quantity: 1 });
    expect(res.status).toBe(403);
    expect(h.withIdempotency).not.toHaveBeenCalled();
    expect(h.addInvoiceLine).not.toHaveBeenCalled();
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED without a key (or a malformed one)", async () => {
    for (const key of [null, "", "has space", "x".repeat(65)]) {
      const res = await post({ invoiceId: INV, pricebookItemId: PB, quantity: 1 }, key);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ success: false, error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Missing idempotency key." } });
    }
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });

  it("400 INVALID_INPUT for bad bodies", async () => {
    const bad: unknown[] = [
      { invoiceId: INV, pricebookItemId: PB, quantity: 0 },
      { invoiceId: INV, pricebookItemId: PB, quantity: 1000 },
      { invoiceId: INV, pricebookItemId: PB, quantity: 1.5 },
      { invoiceId: INV, pricebookItemId: PB },
      { invoiceId: "nope", jobMaterialId: MAT },
      { invoiceId: INV, jobMaterialId: "nope" },
      { invoiceId: INV, jobMaterialId: MAT, quantity: 2 },
      { invoiceId: INV, jobMaterialId: MAT, pricebookItemId: PB },
      { jobMaterialId: MAT },
      {},
    ];
    for (const body of bad) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await json(res)).toEqual({ success: false, error: { code: "INVALID_INPUT", message: "Couldn't save that. Try again." } });
    }
    expect((await post(null, "k-1", "{not json")).status).toBe(400);
    expect((await post(null, "k-1", "")).status).toBe(400);
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });

  it("409 STALE when the invoice isn't the newest live one; the writer is not called", async () => {
    h.resolveTarget.mockResolvedValue("stale");
    const res = await post({ invoiceId: INV, pricebookItemId: PB, quantity: 2 });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ success: false, error: { code: "STALE", message: "This job changed. Refresh and try again." } });
    expect(h.resolveTarget).toHaveBeenCalledWith(ORG, RID, INV, "newest");
    expect(h.addInvoiceLine).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("404 NOT_FOUND when there is no such invoice", async () => {
    h.resolveTarget.mockResolvedValue("not_found");
    const res = await post({ invoiceId: INV, jobMaterialId: MAT });
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe("NOT_FOUND");
    expect(h.addInvoiceLine).not.toHaveBeenCalled();
  });

  it("201 { lineId, invoiceId } for a pricebook line; scope, actor and derived id wired", async () => {
    const res = await post({ invoiceId: INV, pricebookItemId: PB, quantity: 3 }, "key_A");
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ success: true, data: { lineId: LINE, invoiceId: INV } });
    expect(h.withIdempotency.mock.calls[0][0]).toEqual({ organizationId: ORG, userId: U, route: PATH, key: "key_A" });
    expect(h.addInvoiceLine).toHaveBeenCalledWith(
      { organizationId: ORG, requestId: RID, techUserId: U }, INV, { lineId: LINE }, { pricebookItemId: PB, quantity: 3 },
    );
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORG, userId: U, action: "invoice_line_added", details: `invoiceId:${INV} lineId:${LINE}`,
    }));
  });

  it("passes a material line through and returns the writer's (material-derived) line id", async () => {
    h.addInvoiceLine.mockResolvedValue({ ok: true, lineId: "66666666-6666-4666-8666-666666666666" });
    const res = await post({ invoiceId: INV, jobMaterialId: MAT });
    expect(res.status).toBe(201);
    expect((await json(res)).data).toEqual({ lineId: "66666666-6666-4666-8666-666666666666", invoiceId: INV });
    expect(h.addInvoiceLine.mock.calls[0][3]).toEqual({ jobMaterialId: MAT });
  });

  it("a writer-level replay (material line already on this invoice) is 201 without a second audit", async () => {
    h.addInvoiceLine.mockResolvedValue({ ok: true, lineId: LINE, replayed: true });
    const res = await post({ invoiceId: INV, jobMaterialId: MAT });
    expect(res.status).toBe(201);
    expect((await json(res)).data).toEqual({ lineId: LINE, invoiceId: INV });
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("maps writer refusals through the §6.3 table, without an audit", async () => {
    const cases: [string, number, string][] = [
      ["already_billed", 409, "ALREADY_BILLED"], ["invoice_locked", 409, "INVOICE_LOCKED"],
      ["item_not_found", 404, "ITEM_NOT_FOUND"], ["invoice_voided", 409, "INVOICE_VOIDED"],
      ["not_lead", 403, "NOT_LEAD"], ["stale", 409, "STALE"],
    ];
    for (const [reason, status, code] of cases) {
      h.addInvoiceLine.mockResolvedValueOnce({ ok: false, reason });
      const res = await post({ invoiceId: INV, jobMaterialId: MAT });
      expect(res.status).toBe(status);
      expect((await json(res)).error?.code).toBe(code);
    }
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("replay: neither the target check nor the writer runs; the stored envelope and status come back", async () => {
    h.replay.current = { status: 201, envelope: { success: true, data: { lineId: LINE, invoiceId: INV } } };
    const res = await post({ invoiceId: INV, pricebookItemId: PB, quantity: 1 });
    expect(res.status).toBe(201);
    expect((await json(res)).data).toEqual({ lineId: LINE, invoiceId: INV, replayed: true });
    expect(h.resolveTarget).not.toHaveBeenCalled();
    expect(h.addInvoiceLine).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("500 INTERNAL_ERROR with fixed copy when something throws", async () => {
    h.addInvoiceLine.mockRejectedValue(new Error("db secret"));
    const res = await post({ invoiceId: INV, jobMaterialId: MAT });
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });
});
