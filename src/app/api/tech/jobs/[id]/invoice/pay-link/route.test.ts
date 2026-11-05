import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  techWritePreamble: vi.fn(),
  resolveTarget: vi.fn(),
  sendInvoicePayLink: vi.fn(),
  withIdempotency: vi.fn(),
  after: vi.fn(),
  processPendingJobs: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/tech/invoice-route-guards", () => ({
  techWritePreamble: h.techWritePreamble,
  resolveTarget: h.resolveTarget,
}));
vi.mock("@/lib/communication/money-triggers", () => ({ sendInvoicePayLink: h.sendInvoicePayLink }));
vi.mock("@/lib/communication/job-queue", () => ({ processPendingJobs: h.processPendingJobs }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: h.after,
}));

import { POST } from "./route";
import type { RunResult } from "@/lib/http/idempotency";

const ID = "22222222-2222-4222-8222-222222222222";
const INV = "33333333-3333-4333-8333-333333333333";
const ctx = { params: Promise.resolve({ id: ID }) };
const req = (body: unknown, key: string | null = "key-1") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return new NextRequest(`http://localhost/api/tech/jobs/${ID}/invoice/pay-link`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
};

let lastRun: RunResult | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  lastRun = null;
  h.techWritePreamble.mockResolvedValue({
    ok: true,
    session: { userId: "u1", organizationId: "o1" },
    job: { id: ID, native: true, status: "arrived", customerId: null },
    requestId: ID,
  });
  h.resolveTarget.mockResolvedValue("ok");
  h.sendInvoicePayLink.mockResolvedValue({ ok: true });
  h.logAudit.mockResolvedValue(undefined);
  h.processPendingJobs.mockResolvedValue({});
  h.withIdempotency.mockImplementation(async (_scope, _hash, run) => {
    lastRun = await run({ id: (n: string) => n });
    return { ...lastRun, replayed: false };
  });
});

describe("POST /api/tech/jobs/[id]/invoice/pay-link", () => {
  it("returns the preamble's response unchanged", async () => {
    h.techWritePreamble.mockResolvedValue({ ok: false, response: NextResponse.json({ x: 1 }, { status: 403 }) });
    const res = await POST(req({ invoiceId: INV }), ctx);
    expect(res.status).toBe(403);
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });

  it("400 INVALID_INPUT on a bad body", async () => {
    const res = await POST(req({ invoiceId: "nope" }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_INPUT");
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED without a key", async () => {
    const res = await POST(req({ invoiceId: INV }, null), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Missing idempotency key." },
    });
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });

  it("200 queued; scope is the literal path; drains in after() and audits", async () => {
    const res = await POST(req({ invoiceId: INV }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { queued: true } });
    expect(h.withIdempotency.mock.calls[0][0]).toEqual({
      organizationId: "o1",
      userId: "u1",
      route: `/api/tech/jobs/${ID}/invoice/pay-link`,
      key: "key-1",
    });
    expect(h.resolveTarget).toHaveBeenCalledWith("o1", ID, INV, "any");
    expect(h.sendInvoicePayLink).toHaveBeenCalledWith("o1", INV, { requestId: ID, techUserId: "u1" });
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.processPendingJobs).not.toHaveBeenCalled();
    await h.after.mock.calls[0][0]();
    expect(h.processPendingJobs).toHaveBeenCalledTimes(1);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "o1", userId: "u1", action: "pay_link_sent", entity: "invoice", entityId: INV, details: `invoiceId:${INV}`,
    }));
  });

  it("a drain failure inside after() only logs", async () => {
    h.processPendingJobs.mockRejectedValue(new Error("twilio"));
    await POST(req({ invoiceId: INV }), ctx);
    await expect(h.after.mock.calls[0][0]()).resolves.toBeUndefined();
  });

  it("send_failed → the run hands back a 500 SEND_FAILED envelope; no drain, no audit", async () => {
    h.sendInvoicePayLink.mockResolvedValue({ ok: false, reason: "send_failed" });
    const res = await POST(req({ invoiceId: INV }), ctx);
    expect(lastRun).toEqual({
      status: 500,
      envelope: { success: false, error: { message: "The link may not have gone out. Try again in 5 minutes.", code: "SEND_FAILED" } },
    });
    expect(res.status).toBe(500);
    expect(h.after).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("cooldown → 409 COOLDOWN via reasonResult", async () => {
    h.sendInvoicePayLink.mockResolvedValue({ ok: false, reason: "cooldown" });
    const res = await POST(req({ invoiceId: INV }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("COOLDOWN");
    expect(h.after).not.toHaveBeenCalled();
  });

  it("an unknown body key → 400 INVALID_INPUT (strict body), nothing sent", async () => {
    const res = await POST(req({ invoiceId: INV, extra: 1 }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_INPUT");
    expect(h.withIdempotency).not.toHaveBeenCalled();
    expect(h.sendInvoicePayLink).not.toHaveBeenCalled();
  });

  it("not_lead from the sender's in-write gate → 403 NOT_LEAD", async () => {
    h.sendInvoicePayLink.mockResolvedValue({ ok: false, reason: "not_lead" });
    const res = await POST(req({ invoiceId: INV }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("NOT_LEAD");
  });

  it("stale target → 409 STALE; not_found target → 404; the sender is never called", async () => {
    h.resolveTarget.mockResolvedValue("stale");
    let res = await POST(req({ invoiceId: INV }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("STALE");
    h.resolveTarget.mockResolvedValue("not_found");
    res = await POST(req({ invoiceId: INV }), ctx);
    expect(res.status).toBe(404);
    expect(h.sendInvoicePayLink).not.toHaveBeenCalled();
  });

  it("replay → stored status, no run, no after, no audit", async () => {
    h.withIdempotency.mockResolvedValue({ status: 200, envelope: { success: true, data: { queued: true } }, replayed: true });
    const res = await POST(req({ invoiceId: INV }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ queued: true, replayed: true });
    expect(h.sendInvoicePayLink).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("500 with human copy when the sender throws", async () => {
    h.sendInvoicePayLink.mockRejectedValue(new Error("db secret"));
    const res = await POST(req({ invoiceId: INV }), ctx);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
