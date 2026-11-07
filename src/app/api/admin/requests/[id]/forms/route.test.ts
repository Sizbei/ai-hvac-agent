import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ getAdminSession: vi.fn(), slidingWindow: vi.fn(), logAudit: vi.fn(), getRequestForms: vi.fn(), reopen: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/session", () => ({ getAdminSession: h.getAdminSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: h.slidingWindow }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/admin/form-queries", () => ({ getRequestForms: h.getRequestForms, reopenSubmission: h.reopen }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() }, errorCode: () => "x" }));

import { GET } from "./route";
import { POST as REOPEN } from "./[submissionId]/reopen/route";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
const reopen = (b: unknown, sid = SID) => REOPEN(new NextRequest(`http://localhost/api/admin/requests/${RID}/forms/${sid}/reopen`, { method: "POST", body: JSON.stringify(b) }), { params: Promise.resolve({ id: RID, submissionId: sid }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.getAdminSession.mockResolvedValue({ userId: U, organizationId: ORG, role: "admin" });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.logAudit.mockResolvedValue(undefined);
});

describe("GET /api/admin/requests/[id]/forms", () => {
  it("401 / 400 / 404 / 200", async () => {
    const get = (id = RID) => GET(new NextRequest("http://x"), { params: Promise.resolve({ id }) });
    h.getAdminSession.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    expect((await get("nope")).status).toBe(400);
    h.getRequestForms.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(404);
    h.getRequestForms.mockResolvedValueOnce({ submissions: [], missingRequired: [] });
    expect(await json(await get())).toEqual({ success: true, data: { submissions: [], missingRequired: [] } });
    expect(h.getRequestForms).toHaveBeenLastCalledWith(ORG, RID);
  });
});

describe("POST …/reopen (spec §5.5)", () => {
  it("changed → audit form_reopened with ids; already a draft → changed:false, no audit", async () => {
    h.reopen.mockResolvedValueOnce({ ok: true, revision: 5, changed: true, formId: "f", appointmentId: "a" });
    expect(await json(await reopen({ revision: 4 }))).toEqual({ success: true, data: { revision: 5, changed: true } });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "form_reopened", entityId: SID, details: JSON.stringify({ formId: "f", appointmentId: "a" }) }));
    h.reopen.mockResolvedValueOnce({ ok: true, revision: 5, changed: false, formId: "f", appointmentId: "a" });
    expect((await json(await reopen({ revision: 4 }))).data).toEqual({ revision: 5, changed: false });
    expect(h.logAudit).toHaveBeenCalledTimes(1);
  });

  it("STALE / ANSWERS_REMOVED / 404 / bad ids and bodies", async () => {
    h.reopen.mockResolvedValueOnce({ ok: false, reason: "stale" });
    expect(await json(await reopen({ revision: 1 }))).toMatchObject({ error: { code: "STALE", message: "Someone else changed this form. Reload to see the latest." } });
    h.reopen.mockResolvedValueOnce({ ok: false, reason: "answers_removed" });
    expect((await reopen({ revision: 1 })).status).toBe(409);
    h.reopen.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    expect((await reopen({ revision: 1 })).status).toBe(404);
    expect((await reopen({ revision: 1 }, "nope")).status).toBe(400);
    expect((await reopen({ revision: -1 })).status).toBe(400);
  });
});
