import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  preamble: vi.fn(),
  getTechSession: vi.fn(),
  slidingWindow: vi.fn(),
  getView: vi.fn(),
  withIdempotency: vi.fn(),
  replay: { current: null as null | { status: number; envelope: unknown } },
  create: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: h.slidingWindow }));
vi.mock("@/lib/tech/invoice-route-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/tech/invoice-route-guards")>()),
  techWritePreamble: h.preamble,
}));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("@/lib/tech/estimate-queries", () => ({ getTechEstimatesView: h.getView }));
vi.mock("@/lib/tech/estimate-writes", () => ({ createFieldEstimate: h.create }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, errorCode: () => "x" }));

import { GET, POST } from "./route";
import { ESTIMATE_PREAMBLE } from "@/lib/tech/invoice-route-guards";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const ITEM = "33333333-3333-4333-8333-333333333333";
const EST = "44444444-4444-4444-8444-444444444444";
const PATH = `/api/tech/jobs/${RID}/estimates`;
const ctx = { params: Promise.resolve({ id: RID }) };
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: unknown } };
const post = (body: unknown, key: string | null = "k-1", raw?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }), ctx);
};
const get = () => GET(new NextRequest(`http://localhost${PATH}`), ctx);
const BODY = { options: [{ name: "Good", lines: [{ pricebookItemId: ITEM, quantity: 2 }] }, { name: "Better", lines: [{ pricebookItemId: ITEM, quantity: 3 }] }] };

beforeEach(() => {
  vi.clearAllMocks();
  h.replay.current = null;
  h.getTechSession.mockResolvedValue({ userId: U, organizationId: ORG });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.withIdempotency.mockImplementation(async (_s: unknown, _h: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    h.replay.current ? { ...h.replay.current, replayed: true } : { ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false });
  h.create.mockResolvedValue({ ok: true, estimateId: EST, created: true });
  h.getView.mockResolvedValue({ kind: "ok", view: { estimates: [] } });
});

describe("GET /api/tech/jobs/[id]/estimates", () => {
  it("401 without a session; 400 on a bad id; 429 over the read limit", async () => {
    h.getTechSession.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    expect((await GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(400);
    h.slidingWindow.mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 1 });
    expect((await get()).status).toBe(429);
  });
  it("404 not readable; 409 MANAGED_EXTERNALLY on a FieldPulse job; 200 the view", async () => {
    h.getView.mockResolvedValueOnce({ kind: "not_found" });
    expect((await get()).status).toBe(404);
    h.getView.mockResolvedValueOnce({ kind: "external" });
    const ext = await get();
    expect(ext.status).toBe(409);
    expect((await json(ext)).error?.code).toBe("MANAGED_EXTERNALLY");
    const ok = await get();
    expect(ok.status).toBe(200);
    expect(h.getView).toHaveBeenCalledWith(ORG, U, RID);
  });
});

describe("POST /api/tech/jobs/[id]/estimates", () => {
  it("uses the estimate preamble and returns its refusal untouched", async () => {
    h.preamble.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ success: false, error: { code: "NOT_ON_SITE", message: "Arrive at the job first." } }, { status: 409 }) });
    expect((await post(BODY)).status).toBe(409);
    expect(h.preamble).toHaveBeenCalledWith(expect.anything(), RID, ESTIMATE_PREAMBLE);
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });
  it("400 INVALID_INPUT for bad bodies: no options, 4 options, empty option, qty 0 / 1000, long name, extra keys", async () => {
    const line = { pricebookItemId: ITEM, quantity: 1 };
    for (const body of [
      { options: [] },
      { options: [1, 2, 3, 4].map((i) => ({ name: `O${i}`, lines: [line] })) },
      { options: [{ name: "Good", lines: [] }] },
      { options: [{ name: "Good", lines: [{ ...line, quantity: 0 }] }] },
      { options: [{ name: "Good", lines: [{ ...line, quantity: 1000 }] }] },
      { options: [{ name: "x".repeat(41), lines: [line] }] },
      { options: [{ name: "Good", lines: [line], extra: 1 }] },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await json(res)).error?.code).toBe("INVALID_INPUT");
    }
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });
  it("400 'Two options have the same name.' case-insensitively", async () => {
    const res = await post({ options: [{ name: "Good", lines: BODY.options[0]!.lines }, { name: " good", lines: BODY.options[0]!.lines }] });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toEqual({ code: "INVALID_INPUT", message: "Two options have the same name." });
  });
  it("400 IDEMPOTENCY_KEY_REQUIRED without a key", async () => {
    expect((await json(await post(BODY, null))).error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
  it("201 on create with the derived id and an estimate_created audit; 200 on a re-run without one", async () => {
    const res = await post(BODY);
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ success: true, data: { estimateId: EST, created: true } });
    expect(h.create).toHaveBeenCalledWith({ organizationId: ORG, requestId: RID, techUserId: U }, { estimateId: "derived-estimate" }, BODY);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "estimate_created", entity: "estimate", entityId: EST, details: `estimateId:${EST} options:2` }));
    h.logAudit.mockClear();
    h.create.mockResolvedValueOnce({ ok: true, estimateId: EST, created: false });
    expect((await post(BODY)).status).toBe(200);
    expect(h.logAudit).not.toHaveBeenCalled();
  });
  it("maps writer refusals", async () => {
    for (const [reason, status, code] of [["no_customer", 409, "NO_CUSTOMER"], ["not_lead", 403, "NOT_LEAD"], ["job_closed", 409, "JOB_CLOSED"], ["item_inactive", 400, "INVALID_INPUT"], ["too_large", 400, "INVALID_INPUT"], ["stale", 409, "STALE"]] as const) {
      h.create.mockResolvedValueOnce({ ok: false, reason });
      const res = await post(BODY);
      expect(res.status).toBe(status);
      expect((await json(res)).error?.code).toBe(code);
    }
    expect(h.logAudit).not.toHaveBeenCalled();
  });
  it("a replay returns the stored status and writes no audit", async () => {
    h.replay.current = { status: 201, envelope: { success: true, data: { estimateId: EST, created: true } } };
    const res = await post(BODY);
    expect(res.status).toBe(201);
    expect((await json(res)).data).toEqual({ estimateId: EST, created: true, replayed: true });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});
