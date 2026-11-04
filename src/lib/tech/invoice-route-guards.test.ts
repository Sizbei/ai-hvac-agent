import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  getTechSession: vi.fn(),
  isSameOriginRequest: vi.fn(),
  slidingWindow: vi.fn(),
  findReadableJob: vi.fn(),
  findActiveVisit: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/session-csrf", () => ({ isSameOriginRequest: h.isSameOriginRequest }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  slidingWindow: h.slidingWindow,
}));
vi.mock("@/lib/tech/ownership", async (orig) => ({
  ...(await orig<typeof import("@/lib/tech/ownership")>()),
  findReadableJob: h.findReadableJob,
  findActiveVisit: h.findActiveVisit,
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));

import { resolveTarget, techWritePreamble } from "./invoice-route-guards";
import { RATE_LIMITS } from "@/lib/rate-limit";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const INV = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const SESSION = { userId: ME, organizationId: ORG, email: "t@x", name: "T", role: "technician" };
const JOB = { id: REQ, customerId: null, native: true, status: "arrived" };

const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.replace(/\s+/g, " ");
const req = new Request("http://localhost/api/tech/jobs/x/invoice", { method: "POST" }) as never;

async function expectFail(status: number, code: string, message: string, id = REQ) {
  const r = await techWritePreamble(req, id);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.response.status).toBe(status);
  expect(await r.response.json()).toEqual({ success: false, error: { code, message } });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getTechSession.mockResolvedValue(SESSION);
  h.isSameOriginRequest.mockReturnValue(true);
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.findReadableJob.mockResolvedValue(JOB);
  h.findActiveVisit.mockResolvedValue({ appointmentId: "a", leadTechnicianId: ME });
});

describe("techWritePreamble", () => {
  it("401 without a session; nothing else runs", async () => {
    h.getTechSession.mockResolvedValue(null);
    await expectFail(401, "UNAUTHORIZED", "Unauthorized");
    expect(h.isSameOriginRequest).not.toHaveBeenCalled();
    expect(h.slidingWindow).not.toHaveBeenCalled();
  });

  it("403 FORBIDDEN cross-origin, before the id check", async () => {
    h.isSameOriginRequest.mockReturnValue(false);
    await expectFail(403, "FORBIDDEN", "Forbidden", "not-a-uuid");
    expect(h.slidingWindow).not.toHaveBeenCalled();
  });

  it("400 INVALID_ID before the rate limit", async () => {
    await expectFail(400, "INVALID_ID", "Invalid request ID format", "not-a-uuid");
    expect(h.slidingWindow).not.toHaveBeenCalled();
  });

  it("429 on the tech write key before any read", async () => {
    h.slidingWindow.mockReturnValue({ allowed: false, remaining: 0, resetMs: 1 });
    await expectFail(429, "RATE_LIMITED", "Too many requests. Wait a moment and try again.");
    expect(h.slidingWindow).toHaveBeenCalledWith(
      `tech:invoice:write:${ME}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs,
    );
    expect(h.findReadableJob).not.toHaveBeenCalled();
  });

  it("404 when the job is not readable", async () => {
    h.findReadableJob.mockResolvedValue(null);
    await expectFail(404, "NOT_FOUND", "This job isn't yours.");
    expect(h.findReadableJob).toHaveBeenCalledWith(ORG, ME, REQ);
    expect(h.findActiveVisit).not.toHaveBeenCalled();
  });

  it("409 MANAGED_EXTERNALLY for a FieldPulse/HCP job, before the lead check", async () => {
    h.findReadableJob.mockResolvedValue({ ...JOB, native: false });
    await expectFail(409, "MANAGED_EXTERNALLY", "This job is managed in FieldPulse.");
    expect(h.findActiveVisit).not.toHaveBeenCalled();
  });

  it("403 NOT_LEAD when the active visit's lead is someone else, before the on-site check", async () => {
    h.findActiveVisit.mockResolvedValue({ appointmentId: "a", leadTechnicianId: OTHER });
    h.findReadableJob.mockResolvedValue({ ...JOB, status: "scheduled" });
    await expectFail(403, "NOT_LEAD", "Only the lead technician can do that.");
  });

  it("403 NOT_LEAD when there is no active visit", async () => {
    h.findActiveVisit.mockResolvedValue(null);
    await expectFail(403, "NOT_LEAD", "Only the lead technician can do that.");
  });

  it.each(["scheduled", "assigned", "en_route", "cancelled", "submitted"])("409 NOT_ON_SITE while %s", async (status) => {
    h.findReadableJob.mockResolvedValue({ ...JOB, status });
    await expectFail(409, "NOT_ON_SITE", "Arrive at the job before invoicing.");
  });

  it.each(["arrived", "in_progress", "on_hold", "completed"])("passes while %s", async (status) => {
    h.findReadableJob.mockResolvedValue({ ...JOB, status });
    const r = await techWritePreamble(req, REQ);
    expect(r).toEqual({ ok: true, session: SESSION, job: { ...JOB, status }, requestId: REQ });
  });
});

describe("resolveTarget", () => {
  it("newest: ok when the id is the newest live native invoice", async () => {
    h.execute.mockResolvedValue({ rows: [{ id: INV }] });
    expect(await resolveTarget(ORG, REQ, INV, "newest")).toBe("ok");
    const s = render(h.execute.mock.calls[0]![0]);
    expect(s).toContain("(state = 'draft'::invoice_state OR state = 'open'::invoice_state)");
    expect(s).toContain("fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL");
    expect(s).toContain("ORDER BY created_at DESC, id DESC LIMIT 1");
    expect(dialect.sqlToQuery(h.execute.mock.calls[0]![0] as SQL).params).toEqual([ORG, REQ]);
  });

  it("newest: stale when a newer live invoice exists", async () => {
    h.execute.mockResolvedValue({ rows: [{ id: OTHER }] });
    expect(await resolveTarget(ORG, REQ, INV, "newest")).toBe("stale");
  });

  it("newest: stale when no live invoice remains (voided)", async () => {
    h.execute.mockResolvedValue({ rows: [] });
    expect(await resolveTarget(ORG, REQ, INV, "newest")).toBe("stale");
  });

  it("any: ok for a non-void native invoice of the request", async () => {
    h.execute.mockResolvedValue({ rows: [{ id: INV }] });
    expect(await resolveTarget(ORG, REQ, INV, "any")).toBe("ok");
    const q = dialect.sqlToQuery(h.execute.mock.calls[0]![0] as SQL);
    expect(q.sql).toContain("state <> 'void'::invoice_state");
    expect(q.sql).toContain("fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL");
    expect(q.params).toEqual([INV, ORG, REQ]);
  });

  const HEX = "abcdef12-3456-4abc-8def-abcdefabcdef";
  it("newest: an uppercase id from the client is not stale", async () => {
    h.execute.mockResolvedValue({ rows: [{ id: HEX }] });
    expect(await resolveTarget(ORG, REQ, HEX.toUpperCase(), "newest")).toBe("ok");
  });

  it("any: the id is queried lowercased", async () => {
    h.execute.mockResolvedValue({ rows: [{ id: HEX }] });
    expect(await resolveTarget(ORG, REQ, HEX.toUpperCase(), "any")).toBe("ok");
    expect(dialect.sqlToQuery(h.execute.mock.calls[0]![0] as SQL).params[0]).toBe(HEX);
  });

  it("any: not_found otherwise", async () => {
    h.execute.mockResolvedValue({ rows: [] });
    expect(await resolveTarget(ORG, REQ, INV, "any")).toBe("not_found");
  });
});
