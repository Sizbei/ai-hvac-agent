import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  preamble: vi.fn(),
  withIdempotency: vi.fn(),
  decline: vi.fn(),
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
vi.mock("@/lib/tech/estimate-writes", () => ({ declineFieldEstimate: h.decline }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, errorCode: () => "x" }));

import { POST } from "./route";
import { ESTIMATE_PREAMBLE } from "@/lib/tech/invoice-route-guards";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const EST = "44444444-4444-4444-8444-444444444444";
const PATH = `/api/tech/jobs/${RID}/estimates/${EST}/decline`;
const ctx = { params: Promise.resolve({ id: RID, eid: EST }) };
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
const post = (body: unknown, key: string | null = "k-1") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: JSON.stringify(body) }), ctx);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.withIdempotency.mockImplementation(async (_s: unknown, _h: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    ({ ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false }));
});

describe("POST /api/tech/jobs/[id]/estimates/[eid]/decline", () => {
  it("uses the estimate preamble", async () => {
    h.decline.mockResolvedValueOnce({ ok: true, estimateId: EST, created: true });
    await post({});
    expect(h.preamble).toHaveBeenCalledWith(expect.anything(), RID, ESTIMATE_PREAMBLE);
    expect(h.decline).toHaveBeenCalledWith({ organizationId: ORG, requestId: RID, techUserId: U }, EST);
  });
  it("200 { estimateId, status: 'dismissed', created } with an estimate_declined audit only when it changed", async () => {
    h.decline.mockResolvedValueOnce({ ok: true, estimateId: EST, created: true });
    expect((await json(await post({}))).data).toEqual({ estimateId: EST, status: "dismissed", created: true });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "estimate_declined", details: `estimateId:${EST}` }));
    h.logAudit.mockClear();
    h.decline.mockResolvedValueOnce({ ok: true, estimateId: EST, created: false });
    expect((await post({})).status).toBe(200);
    expect(h.logAudit).not.toHaveBeenCalled();
  });
  it("ALREADY_DECIDED / NOT_FOUND / NOT_LEAD; extra keys 400", async () => {
    for (const [reason, status, code] of [["already_decided", 409, "ALREADY_DECIDED"], ["estimate_not_found", 404, "NOT_FOUND"], ["not_lead", 403, "NOT_LEAD"]] as const) {
      h.decline.mockResolvedValueOnce({ ok: false, reason });
      const res = await post({});
      expect([res.status, (await json(res)).error?.code]).toEqual([status, code]);
    }
    expect((await post({ x: 1 })).status).toBe(400);
  });
});
