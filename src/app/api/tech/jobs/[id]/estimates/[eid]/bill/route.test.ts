import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  preamble: vi.fn(),
  withIdempotency: vi.fn(),
  replay: { current: null as null | { status: number; envelope: unknown } },
  bill: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/tech/invoice-route-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/tech/invoice-route-guards")>()),
  techWritePreamble: h.preamble,
}));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("@/lib/admin/invoice-field-writes", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin/invoice-field-writes")>()),
  billSoldEstimate: h.bill,
}));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, errorCode: () => "x" }));

import { POST } from "./route";
import { BILL_PREAMBLE } from "@/lib/tech/invoice-route-guards";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const EST = "44444444-4444-4444-8444-444444444444";
const PATH = `/api/tech/jobs/${RID}/estimates/${EST}/bill`;
const ctx = { params: Promise.resolve({ id: RID, eid: EST }) };
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: unknown } };
const post = (body: unknown, key: string | null = "k-1", raw?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }), ctx);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.replay.current = null;
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.withIdempotency.mockImplementation(async (_s: unknown, _h: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    h.replay.current ? { ...h.replay.current, replayed: true } : { ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false });
  h.bill.mockResolvedValue({ ok: true, invoiceId: "inv-1", added: 2, hasMaterials: true });
});

describe("POST /api/tech/jobs/[id]/estimates/[eid]/bill", () => {
  it("uses the invoicing statuses with the estimate copy; a refusal is returned untouched", async () => {
    h.preamble.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ success: false, error: { code: "JOB_CLOSED", message: "x" } }, { status: 409 }) });
    expect((await post({})).status).toBe(409);
    expect(h.preamble).toHaveBeenCalledWith(expect.anything(), RID, BILL_PREAMBLE);
    expect(h.bill).not.toHaveBeenCalled();
  });
  it("an absent body reads as {}; extra keys are 400; no key is 400", async () => {
    expect((await post(null, "k", "")).status).toBe(200);
    expect((await json(await post({ x: 1 }))).error?.code).toBe("INVALID_INPUT");
    expect((await json(await post({}, null))).error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
  it("200 { invoiceId, added, hasMaterials } with the derived invoice id; estimate_billed audit", async () => {
    const res = await post({});
    expect((await json(res)).data).toEqual({ invoiceId: "inv-1", added: 2, hasMaterials: true });
    expect(h.bill).toHaveBeenCalledWith({ organizationId: ORG, requestId: RID, techUserId: U }, EST, { invoiceId: "derived-invoice" });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "estimate_billed", entity: "estimate", entityId: EST, details: `estimateId:${EST} invoiceId:inv-1 added:2` }));
  });
  it("a key replay returns the stored 200 without an audit", async () => {
    h.replay.current = { status: 200, envelope: { success: true, data: { invoiceId: "inv-1", added: 2, hasMaterials: false } } };
    expect((await post({})).status).toBe(200);
    expect(h.bill).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });
  it("ALREADY_BILLED carries details.invoiceId; the other refusals map with their copy", async () => {
    h.bill.mockResolvedValueOnce({ ok: false, reason: "already_billed", invoiceId: "inv-9" });
    expect((await json(await post({}))).error).toEqual({ code: "ALREADY_BILLED", message: "This estimate is already on an invoice.", details: { invoiceId: "inv-9" } });
    h.bill.mockResolvedValueOnce({ ok: false, reason: "invoice_locked" });
    expect((await json(await post({}))).error).toEqual({ code: "INVOICE_LOCKED", message: "The job's invoice is already finalized. Ask the office to bill this estimate." });
    h.bill.mockResolvedValueOnce({ ok: false, reason: "invoice_changed" });
    expect((await json(await post({}))).error).toEqual({ code: "INVOICE_CHANGED", message: "The job's invoice changed. Try again." });
    for (const [reason, status, code] of [["no_lines", 409, "NO_LINES"], ["estimate_not_sold", 409, "ESTIMATE_NOT_SOLD"], ["stale", 409, "STALE"], ["too_large", 400, "INVALID_INPUT"], ["managed_externally", 409, "MANAGED_EXTERNALLY"], ["estimate_not_found", 404, "NOT_FOUND"], ["not_lead", 403, "NOT_LEAD"]] as const) {
      h.bill.mockResolvedValueOnce({ ok: false, reason });
      const res = await post({});
      expect([res.status, (await json(res)).error?.code]).toEqual([status, code]);
    }
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});
