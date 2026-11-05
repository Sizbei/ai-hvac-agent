import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  after: vi.fn(),
  preamble: vi.fn(),
  resolveTarget: vi.fn(),
  withIdempotency: vi.fn(),
  replay: { current: null as null | { status: number; envelope: unknown } },
  finalizeInvoice: vi.fn(),
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
vi.mock("@/lib/admin/invoice-field-writes", () => ({ finalizeInvoice: h.finalizeInvoice }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { POST } from "./route";
import { NextResponse } from "next/server";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const INV = "22222222-2222-4222-8222-222222222222";
const PATH = `/api/tech/jobs/${RID}/invoice/finalize`;
const ctx = { params: Promise.resolve({ id: RID }) };

function post(body: unknown, key: string | null = "k-1", raw?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }), ctx);
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
      : { ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false });
  h.finalizeInvoice.mockResolvedValue({ ok: true, state: "open", changed: true });
});

describe("POST /api/tech/jobs/[id]/invoice/finalize", () => {
  it("returns the preamble's response and does nothing else", async () => {
    h.preamble.mockResolvedValue({ ok: false, response: NextResponse.json({ success: false, error: { code: "NOT_ON_SITE", message: "x" } }, { status: 409 }) });
    const res = await post({ invoiceId: INV });
    expect(res.status).toBe(409);
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED without a key", async () => {
    const res = await post({ invoiceId: INV }, null);
    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("400 INVALID_INPUT for a non-uuid invoiceId, extra keys, empty or broken bodies", async () => {
    for (const body of [{ invoiceId: "nope" }, { invoiceId: INV, extra: 1 }, {}]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toEqual({ code: "INVALID_INPUT", message: "Couldn't save that. Try again." });
    }
    expect((await post(null, "k", "")).status).toBe(400);
    expect((await post(null, "k", "{")).status).toBe(400);
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });

  it("409 STALE for a non-newest invoice; the writer is not called", async () => {
    h.resolveTarget.mockResolvedValue("stale");
    const res = await post({ invoiceId: INV });
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("STALE");
    expect(h.resolveTarget).toHaveBeenCalledWith(ORG, RID, INV, "newest");
    expect(h.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("404 NOT_FOUND when the target is missing", async () => {
    h.resolveTarget.mockResolvedValue("not_found");
    expect((await post({ invoiceId: INV })).status).toBe(404);
    expect(h.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("200 { invoiceId, state, changed } and an invoice_finalized audit", async () => {
    const res = await post({ invoiceId: INV });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ success: true, data: { invoiceId: INV, state: "open", changed: true } });
    expect(h.finalizeInvoice).toHaveBeenCalledWith({ organizationId: ORG, requestId: RID, techUserId: U }, INV);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "invoice_finalized", details: `invoiceId:${INV}` }));
  });

  it("an unchanged finalize (already open) is 200 without an audit", async () => {
    h.finalizeInvoice.mockResolvedValue({ ok: true, state: "open", changed: false });
    const res = await post({ invoiceId: INV });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ invoiceId: INV, state: "open", changed: false });
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("maps writer refusals (NO_LINES, INVOICE_VOIDED, NOT_LEAD)", async () => {
    for (const [reason, status, code] of [["no_lines", 409, "NO_LINES"], ["invoice_voided", 409, "INVOICE_VOIDED"], ["not_lead", 403, "NOT_LEAD"]] as const) {
      h.finalizeInvoice.mockResolvedValueOnce({ ok: false, reason });
      const res = await post({ invoiceId: INV });
      expect(res.status).toBe(status);
      expect((await json(res)).error?.code).toBe(code);
    }
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("replay: no target check, no writer, no audit; stored status returned", async () => {
    h.replay.current = { status: 200, envelope: { success: true, data: { invoiceId: INV, state: "open", changed: true } } };
    const res = await post({ invoiceId: INV });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ replayed: true, changed: true });
    expect(h.resolveTarget).not.toHaveBeenCalled();
    expect(h.finalizeInvoice).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});
