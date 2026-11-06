import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  preamble: vi.fn(),
  withIdempotency: vi.fn(),
  replay: { current: null as null | { status: number; envelope: unknown } },
  sell: vi.fn(),
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
vi.mock("@/lib/tech/estimate-writes", () => ({ sellFieldEstimate: h.sell }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, errorCode: () => "x" }));

import { POST } from "./route";
import { ESTIMATE_PREAMBLE } from "@/lib/tech/invoice-route-guards";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const EST = "44444444-4444-4444-8444-444444444444";
const OPT = "55555555-5555-4555-8555-555555555555";
const PATH = `/api/tech/jobs/${RID}/estimates/${EST}/sell`;
const ctx = { params: Promise.resolve({ id: RID, eid: EST }) };
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
const post = (body: unknown, key: string | null = "k-1") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: JSON.stringify(body) }), ctx);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.replay.current = null;
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.withIdempotency.mockImplementation(async (_s: unknown, _h: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    h.replay.current ? { ...h.replay.current, replayed: true } : { ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false });
  h.sell.mockResolvedValue({ ok: true, estimateId: EST, created: true });
});

describe("POST /api/tech/jobs/[id]/estimates/[eid]/sell", () => {
  it("uses the estimate preamble and returns its refusal untouched", async () => {
    h.preamble.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ success: false, error: { code: "NOT_LEAD", message: "x" } }, { status: 403 }) });
    expect((await post({ optionId: OPT, signatureName: "Pat Probe" })).status).toBe(403);
    expect(h.preamble).toHaveBeenCalledWith(expect.anything(), RID, ESTIMATE_PREAMBLE);
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });
  it("404 for a non-uuid estimate id", async () => {
    const res = await POST(new NextRequest("http://localhost/x", { method: "POST", headers: { "idempotency-key": "k" }, body: "{}" }),
      { params: Promise.resolve({ id: RID, eid: "nope" }) });
    expect([res.status, (await json(res)).error?.code]).toEqual([404, "NOT_FOUND"]);
  });
  it("400 INVALID_INPUT for a bad body; 400 'Type your full name to approve.' for a 1-letter name or the office marker", async () => {
    for (const body of [{ optionId: "nope", signatureName: "Pat" }, { optionId: OPT }, { optionId: OPT, signatureName: "Pat", x: 1 }]) {
      expect((await json(await post(body))).error?.code).toBe("INVALID_INPUT");
    }
    for (const signatureName of ["P", "  ", "(admin)"]) {
      expect((await json(await post({ optionId: OPT, signatureName }))).error).toEqual({ code: "INVALID_INPUT", message: "Type your full name to approve." });
    }
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });
  it("400 IDEMPOTENCY_KEY_REQUIRED without a key", async () => {
    expect((await json(await post({ optionId: OPT, signatureName: "Pat" }, null))).error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
  it("200 { estimateId, status: 'sold', created } and an estimate_sold audit on a fresh sale", async () => {
    const res = await post({ optionId: OPT, signatureName: " Pat Probe " });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ estimateId: EST, status: "sold", created: true });
    expect(h.sell).toHaveBeenCalledWith({ organizationId: ORG, requestId: RID, techUserId: U }, { estimateId: EST, optionId: OPT, signatureName: " Pat Probe " });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "estimate_sold", entity: "estimate", entityId: EST, details: `estimateId:${EST} optionId:${OPT} via:field` }));
  });
  it("a writer replay (created:false) is 200 without an audit; a key replay writes none either", async () => {
    h.sell.mockResolvedValueOnce({ ok: true, estimateId: EST, created: false });
    expect((await post({ optionId: OPT, signatureName: "Pat" })).status).toBe(200);
    h.replay.current = { status: 200, envelope: { success: true, data: { estimateId: EST, status: "sold", created: true } } };
    expect((await json(await post({ optionId: OPT, signatureName: "Pat" }))).data).toEqual({ estimateId: EST, status: "sold", created: true, replayed: true });
    expect(h.logAudit).not.toHaveBeenCalled();
  });
  it("maps refusals", async () => {
    for (const [reason, status, code] of [["already_decided", 409, "ALREADY_DECIDED"], ["estimate_expired", 409, "ESTIMATE_EXPIRED"], ["invalid_option", 400, "INVALID_OPTION"], ["estimate_not_found", 404, "NOT_FOUND"], ["not_lead", 403, "NOT_LEAD"], ["job_closed", 409, "JOB_CLOSED"], ["stale", 409, "STALE"]] as const) {
      h.sell.mockResolvedValueOnce({ ok: false, reason });
      const res = await post({ optionId: OPT, signatureName: "Pat" });
      expect([res.status, (await json(res)).error?.code]).toEqual([status, code]);
    }
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});
