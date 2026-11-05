import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  getTechSession: vi.fn(),
  slidingWindow: vi.fn(),
  getTechInvoiceView: vi.fn(),
  after: vi.fn(),
  preamble: vi.fn(),
  withIdempotency: vi.fn(),
  replay: { current: null as null | { status: number; envelope: unknown } },
  createInvoiceFromJob: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: h.after }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  slidingWindow: h.slidingWindow,
}));
vi.mock("@/lib/tech/invoice-queries", () => ({ getTechInvoiceView: h.getTechInvoiceView }));
vi.mock("@/lib/tech/invoice-route-guards", () => ({ techWritePreamble: h.preamble, resolveTarget: vi.fn() }));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("@/lib/admin/invoice-field-writes", () => ({ createInvoiceFromJob: h.createInvoiceFromJob }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));

import { GET, POST } from "./route";
import { canonicalHash } from "@/lib/http/idempotency";
import { RATE_LIMITS } from "@/lib/rate-limit";

const ID = "22222222-2222-4222-8222-222222222222";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://localhost/api/tech/jobs/x/invoice") as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.getTechSession.mockResolvedValue({ userId: "u1", organizationId: "o1" });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
});

describe("GET /api/tech/jobs/[id]/invoice", () => {
  it("401 without a tech session", async () => {
    h.getTechSession.mockResolvedValue(null);
    const res = await GET(req(), ctx(ID));
    expect(res.status).toBe(401);
    expect(h.getTechInvoiceView).not.toHaveBeenCalled();
  });

  it("400 INVALID_ID on a malformed id, before the rate limit", async () => {
    const res = await GET(req(), ctx("nope"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ID");
    expect(h.slidingWindow).not.toHaveBeenCalled();
  });

  it("429 on the read key", async () => {
    h.slidingWindow.mockReturnValue({ allowed: false, remaining: 0, resetMs: 1 });
    const res = await GET(req(), ctx(ID));
    expect(res.status).toBe(429);
    expect(h.slidingWindow).toHaveBeenCalledWith("tech:invoice:read:u1", RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    expect(h.getTechInvoiceView).not.toHaveBeenCalled();
  });

  it("404 when the job isn't readable", async () => {
    h.getTechInvoiceView.mockResolvedValue({ kind: "not_found" });
    const res = await GET(req(), ctx(ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "This job isn't yours." } });
  });

  it("409 MANAGED_EXTERNALLY for a FieldPulse/HCP job", async () => {
    h.getTechInvoiceView.mockResolvedValue({ kind: "external" });
    const res = await GET(req(), ctx(ID));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false, error: { code: "MANAGED_EXTERNALLY", message: "This job is managed in FieldPulse." },
    });
  });

  it("200 wraps the view in the success envelope, scoped by the session", async () => {
    const view = { invoice: null, otherOpen: [], history: null, materialsNotOnInvoice: [], pendingWrite: false,
      customerHasPhone: false, isLead: true, onSite: true, externalInvoice: false, allowed: ["create"] };
    h.getTechInvoiceView.mockResolvedValue({ kind: "ok", view });
    const res = await GET(req(), ctx(ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: view });
    expect(h.getTechInvoiceView).toHaveBeenCalledWith("o1", "u1", ID);
  });

  it("500 with human copy when the read throws", async () => {
    h.getTechInvoiceView.mockRejectedValue(new Error("db down secret"));
    const res = await GET(req(), ctx(ID));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});

// ---------------------------------------------------------------- POST (create)

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const INV = "99999999-9999-4999-8999-999999999999";
const PATH = `/api/tech/jobs/${ID}/invoice`;

function create(raw: string | null, key: string | null = "k-1") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: raw }), ctx(ID));
}
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };

describe("POST /api/tech/jobs/[id]/invoice", () => {
  beforeEach(() => {
    h.replay.current = null;
    h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: ID });
    h.withIdempotency.mockImplementation(async (_scope: unknown, _hash: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
      h.replay.current
        ? { ...h.replay.current, replayed: true }
        : { ...(await run({ id: (n) => (n === "invoice" ? INV : `bad-${n}`) }) as object), replayed: false });
    h.createInvoiceFromJob.mockResolvedValue({ ok: true, invoiceId: INV, state: "draft", created: true });
  });

  it("returns the preamble's response and does nothing else", async () => {
    h.preamble.mockResolvedValue({ ok: false, response: NextResponse.json({ success: false, error: { code: "NOT_LEAD", message: "x" } }, { status: 403 }) });
    const res = await create("{}");
    expect(res.status).toBe(403);
    expect(h.preamble.mock.calls[0][1]).toBe(ID);
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED without a key", async () => {
    const res = await create("{}", null);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ success: false, error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Missing idempotency key." } });
  });

  it("an absent, empty or {} body is {} (same hash)", async () => {
    for (const raw of [null, "", "  ", "{}"]) {
      const res = await create(raw);
      expect(res.status, String(raw)).toBe(201);
    }
    for (const call of h.withIdempotency.mock.calls) expect(call[1]).toBe(canonicalHash({}));
  });

  it("400 INVALID_INPUT for extra keys, non-objects or broken JSON", async () => {
    for (const raw of ['{"invoiceId":"x"}', "[]", "null", "{"]) {
      const res = await create(raw);
      expect(res.status, raw).toBe(400);
      expect((await json(res)).error).toEqual({ code: "INVALID_INPUT", message: "Couldn't save that. Try again." });
    }
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });

  it("201 when created; scope, actor and derived id wired; invoice_created audit", async () => {
    const res = await create("{}", "key_C");
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ success: true, data: { invoiceId: INV, state: "draft", created: true } });
    expect(h.withIdempotency.mock.calls[0][0]).toEqual({ organizationId: ORG, userId: U, route: PATH, key: "key_C" });
    expect(h.createInvoiceFromJob).toHaveBeenCalledWith({ organizationId: ORG, requestId: ID, techUserId: U }, { invoiceId: INV });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORG, userId: U, action: "invoice_created", details: `invoiceId:${INV} created:true`,
    }));
  });

  it("200 when an existing draft is adopted", async () => {
    h.createInvoiceFromJob.mockResolvedValue({ ok: true, invoiceId: INV, state: "draft", created: false });
    const res = await create("{}");
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ invoiceId: INV, state: "draft", created: false });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ details: `invoiceId:${INV} created:false` }));
  });

  it("maps writer refusals (EXTERNAL_INVOICE, MANAGED_EXTERNALLY, NOT_LEAD, STALE) without an audit", async () => {
    for (const [reason, status, code] of [["external_invoice", 409, "EXTERNAL_INVOICE"], ["managed_externally", 409, "MANAGED_EXTERNALLY"],
      ["not_lead", 403, "NOT_LEAD"], ["stale", 409, "STALE"]] as const) {
      h.createInvoiceFromJob.mockResolvedValueOnce({ ok: false, reason });
      const res = await create("{}");
      expect(res.status).toBe(status);
      expect((await json(res)).error?.code).toBe(code);
    }
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("replay: the writer never runs; stored 201 + replayed; no audit", async () => {
    h.replay.current = { status: 201, envelope: { success: true, data: { invoiceId: INV, state: "draft", created: true } } };
    const res = await create("{}");
    expect(res.status).toBe(201);
    expect((await json(res)).data).toEqual({ invoiceId: INV, state: "draft", created: true, replayed: true });
    expect(h.createInvoiceFromJob).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("an audit failure does not fail the write", async () => {
    h.logAudit.mockRejectedValueOnce(new Error("audit down"));
    expect((await create("{}")).status).toBe(201);
  });

  it("500 INTERNAL_ERROR with fixed copy when the writer throws", async () => {
    h.createInvoiceFromJob.mockRejectedValue(new Error("db secret"));
    const res = await create("{}");
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });
});
