import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({ getTechSession: vi.fn(), findReadableJob: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute, batch: vi.fn() } }));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/session-csrf", () => ({ isSameOriginRequest: () => true }));
vi.mock("@/lib/tech/ownership", async (orig) => ({ ...(await orig<typeof import("@/lib/tech/ownership")>()), findReadableJob: h.findReadableJob }));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));

import { findSubmitReplay, techFormFront, techFormGate } from "./form-route-guards";
import { resetRateLimitStore } from "@/lib/rate-limit";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const FORM = "44444444-4444-4444-8444-444444444444";
const AID = "abcdef00-0000-4000-8000-000000000000";
const SESSION = { userId: ME, organizationId: ORG, email: "t@x", name: "T", role: "technician" as const };
const req = () => new NextRequest(`http://localhost/api/tech/jobs/${RID}/forms/${FORM}/draft`, { method: "PUT" });
const gates = (over: Record<string, unknown> = {}) => ({
  status: "arrived", native: true, customer_erased: false, visit_found: true, visit_live: true, my_row: true, my_live_row: true,
  my_progress: false, form_found: true, form_active: true, form_version: 1, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitStore();
  h.getTechSession.mockResolvedValue(SESSION);
  h.findReadableJob.mockResolvedValue({ id: RID, customerId: null, native: true, status: "arrived" });
});

describe("techFormFront (spec §6)", () => {
  it("draft bucket: the 31st PUT in a minute passes, the 61st is 429", async () => {
    for (let i = 1; i <= 60; i++) expect((await techFormFront(req(), RID, FORM, "form-draft")).ok).toBe(true);
    const r = await techFormFront(req(), RID, FORM, "form-draft");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(429);
  });

  it("submit bucket keeps the 30/min write limit, separate from drafts", async () => {
    for (let i = 1; i <= 30; i++) expect((await techFormFront(req(), RID, FORM, "form")).ok).toBe(true);
    const r = await techFormFront(req(), RID, FORM, "form");
    if (!r.ok) expect(r.response.status).toBe(429);
    expect(r.ok).toBe(false);
    expect((await techFormFront(req(), RID, FORM, "form-draft")).ok).toBe(true);
  });

  it("a non-uuid form id is 400 INVALID_ID", async () => {
    const r = await techFormFront(req(), RID, "nope", "form-draft");
    expect(r.ok).toBe(false);
    if (!r.ok) expect((await r.response.json()).error.code).toBe("INVALID_ID");
  });
});

describe("techFormGate", () => {
  it("404 when the job isn't readable", async () => {
    h.findReadableJob.mockResolvedValueOnce(null);
    const r = await techFormGate(SESSION, RID, FORM, AID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(404);
  });

  it("maps the gate read: cancelled → 409 JOB_CLOSED; a cancelled visit → VISIT_ENDED; no row → 403 NOT_ASSIGNED", async () => {
    for (const [g, status, code] of [
      [gates({ status: "cancelled", visit_live: false }), 409, "JOB_CLOSED"],
      [gates({ visit_live: false }), 409, "VISIT_ENDED"],
      [gates({ my_row: false, my_live_row: false }), 403, "NOT_ASSIGNED"],
      [gates({ status: "scheduled" }), 409, "NOT_ON_SITE"],
      [gates({ customer_erased: true }), 409, "CUSTOMER_REMOVED"],
    ] as const) {
      h.execute.mockResolvedValueOnce({ rows: [g] });
      const r = await techFormGate(SESSION, RID, FORM, AID.toUpperCase());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(status);
        expect((await r.response.json()).error.code).toBe(code);
      }
    }
  });

  it("passes an on-site technician on the visit", async () => {
    h.execute.mockResolvedValueOnce({ rows: [gates()] });
    expect(await techFormGate(SESSION, RID, FORM, AID)).toEqual({ ok: true });
  });
});

describe("findSubmitReplay (lead ruling, spec §5.3)", () => {
  const KEY = "55555555-5555-4555-8555-555555555555";
  const submitted = (over: Record<string, unknown> = {}) => ({
    id: "s1", status: "submitted", revision: 3, form_version: 1, erased: false, last_save_id: null, submit_key: KEY,
    updated_at: "2026-11-07T10:00:00.000Z", submitted_at: "2026-11-07T10:00:00.000Z", fields: [], values_encrypted: null, ...over,
  });
  const render = (q: unknown) => new PgDialect().sqlToQuery(q as never);

  it("a row submitted with this derived key is the writer's 200, read by the natural key (org, request, visit, form)", async () => {
    h.execute.mockResolvedValueOnce({ rows: [submitted()] });
    expect(await findSubmitReplay(SESSION, RID.toUpperCase(), FORM.toUpperCase(), AID.toUpperCase(), KEY.toUpperCase()))
      .toEqual({ ok: true, submissionId: "s1", revision: 3, submittedAt: "2026-11-07T10:00:00.000Z" });
    const q = render(h.execute.mock.calls[0]![0]);
    expect(q.sql).toContain("organization_id = $1::uuid AND appointment_id = $2::uuid AND form_id = $3::uuid AND service_request_id = $4::uuid");
    expect(q.params).toEqual([ORG, AID, FORM, RID]);
    expect(h.findReadableJob).not.toHaveBeenCalled();
  });

  it("no row, a draft, another key, or an erased row → null (the gates decide)", async () => {
    for (const rows of [[], [submitted({ status: "draft", submit_key: null, submitted_at: null })], [submitted({ submit_key: "66666666-6666-4666-8666-666666666666" })], [submitted({ erased: true })]]) {
      h.execute.mockResolvedValueOnce({ rows });
      expect(await findSubmitReplay(SESSION, RID, FORM, AID, KEY)).toBeNull();
    }
  });
});
