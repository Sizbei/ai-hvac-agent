import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  preamble: vi.fn(),
  resolveTarget: vi.fn(),
  removeInvoiceLine: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/tech/invoice-route-guards", () => ({ techWritePreamble: h.preamble, resolveTarget: h.resolveTarget }));
vi.mock("@/lib/admin/invoice-field-writes", () => ({ removeInvoiceLine: h.removeInvoiceLine }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { DELETE } from "./route";
import { NextResponse } from "next/server";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const INV = "22222222-2222-4222-8222-222222222222";
const LID = "55555555-5555-4555-8555-555555555555";

function del(lid: string, query: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/tech/jobs/${RID}/invoice/lines/${lid}${query}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: RID, lid }) },
  );
}
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };

beforeEach(() => {
  vi.clearAllMocks();
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.resolveTarget.mockResolvedValue("ok");
  h.removeInvoiceLine.mockResolvedValue({ ok: true, removed: true });
});

describe("DELETE /api/tech/jobs/[id]/invoice/lines/[lid]", () => {
  it("returns the preamble's response and does nothing else", async () => {
    h.preamble.mockResolvedValue({ ok: false, response: NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 }) });
    const res = await del(LID, `?invoiceId=${INV}`);
    expect(res.status).toBe(403);
    expect(h.preamble.mock.calls[0][1]).toBe(RID);
    expect(h.resolveTarget).not.toHaveBeenCalled();
  });

  it("400 INVALID_INPUT for a non-uuid line id or a missing/non-uuid invoiceId", async () => {
    for (const [lid, q] of [["nope", `?invoiceId=${INV}`], [LID, ""], [LID, "?invoiceId=nope"]]) {
      const res = await del(lid, q);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toEqual({ code: "INVALID_INPUT", message: "That isn't a valid request." });
    }
    expect(h.resolveTarget).not.toHaveBeenCalled();
  });

  it("409 STALE for a non-newest invoice; the writer is not called", async () => {
    h.resolveTarget.mockResolvedValue("stale");
    const res = await del(LID, `?invoiceId=${INV}`);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ success: false, error: { code: "STALE", message: "This job changed. Refresh and try again." } });
    expect(h.resolveTarget).toHaveBeenCalledWith(ORG, RID, INV, "newest");
    expect(h.removeInvoiceLine).not.toHaveBeenCalled();
  });

  it("404 NOT_FOUND when the target is missing", async () => {
    h.resolveTarget.mockResolvedValue("not_found");
    expect((await del(LID, `?invoiceId=${INV}`)).status).toBe(404);
    expect(h.removeInvoiceLine).not.toHaveBeenCalled();
  });

  it("200 { removed: true } and an invoice_line_removed audit", async () => {
    const res = await del(LID, `?invoiceId=${INV}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ success: true, data: { removed: true } });
    expect(h.removeInvoiceLine).toHaveBeenCalledWith({ organizationId: ORG, requestId: RID, techUserId: U }, INV, LID);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "invoice_line_removed", details: `invoiceId:${INV} lineId:${LID}`,
    }));
  });

  it("200 { removed: false } for a line already gone, without an audit", async () => {
    h.removeInvoiceLine.mockResolvedValue({ ok: true, removed: false });
    const res = await del(LID, `?invoiceId=${INV}`);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ removed: false });
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("maps writer refusals through fieldError", async () => {
    for (const [reason, status, code] of [["invoice_locked", 409, "INVOICE_LOCKED"], ["not_lead", 403, "NOT_LEAD"], ["invoice_voided", 409, "INVOICE_VOIDED"]] as const) {
      h.removeInvoiceLine.mockResolvedValueOnce({ ok: false, reason });
      const res = await del(LID, `?invoiceId=${INV}`);
      expect(res.status).toBe(status);
      expect((await json(res)).error?.code).toBe(code);
    }
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("500 INTERNAL_ERROR when the writer throws", async () => {
    h.removeInvoiceLine.mockRejectedValue(new Error("x"));
    const res = await del(LID, `?invoiceId=${INV}`);
    expect(res.status).toBe(500);
    expect((await json(res)).error?.code).toBe("INTERNAL_ERROR");
  });
});
